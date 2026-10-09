import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import type { App } from '../../src/app-registry/domain/app';
import { createTestApp } from '../support/create-test-app';
import { addTestUser, fingerprint, registerTestApp } from '../support/e2e-fixtures';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const OLD = 'old passphrase';
const NEW = 'a brand new passphrase';
const PAIR_LIMIT = 3;
const INVALID_TOKEN = { error: 'invalid_token', message: 'Missing or invalid access token' };
const INVALID_CURRENT = { error: 'invalid_current_password', message: 'The current password is incorrect.' };

describe('POST /api/v1/password/change (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;
  let oldHash: string;

  const server = () => app.getHttpServer();
  const login = (password: string, client = shop, email = 'ana@example.com') =>
    request(server()).post('/api/v1/auth/login').send({ client_id: client.clientId, email, password });
  const loggedIn = async (client = shop, email = 'ana@example.com') => {
    const response = await login(OLD, client, email).expect(200);
    return { access: response.body.access_token as string, refresh: response.body.refresh_token as string };
  };
  const change = (access: string | undefined, body: Record<string, unknown> = { current_password: OLD, new_password: NEW }) => {
    const req = request(server()).post('/api/v1/password/change').send(body);
    return access === undefined ? req : req.set('Authorization', `Bearer ${access}`);
  };
  const refresh = (client: App, token: string) =>
    request(server()).post('/api/v1/auth/refresh').send({ client_id: client.clientId, refresh_token: token });
  const me = (access: string) => request(server()).get('/api/v1/me').set('Authorization', `Bearer ${access}`);
  const hashOf = async (email = 'ana@example.com', appId = shop.id): Promise<string> =>
    (await db.dataSource.query(`SELECT password_hash FROM users WHERE email = $1 AND app_id = $2`, [email, appId]))[0].password_hash;
  const counterRows = async (): Promise<number> => Number((await db.dataSource.query(`SELECT count(*) AS n FROM abuse_counters`))[0].n);

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({ login_account_ip: { limit: PAIR_LIMIT, blockSeconds: 900 } }),
    });
    oldHash = await new LowCostPasswordHasher().hash(OLD);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    shop = await registerTestApp(app, 'Shop', SHOP_ORIGIN);
    blog = await registerTestApp(app, 'Blog', BLOG_ORIGIN);
    await addTestUser(app, { appId: shop.id, email: 'ana@example.com', passwordHash: oldHash });
  });

  it('answers 204 with no body, kills every refresh token including the caller own, and keeps the access token valid until exp', async () => {
    const first = await loggedIn();
    const second = await loggedIn();

    const response = await change(first.access);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(await hashOf()).not.toBe(oldHash);
    for (const session of [first, second]) {
      const refreshed = await refresh(shop, session.refresh);
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.error).toBe('invalid_grant');
    }
    expect((await me(first.access)).status).toBe(200);
    expect((await login(NEW)).status).toBe(200);
    expect((await login(OLD)).status).toBe(401);
  });

  it('queues the password-changed notice to the account', async () => {
    const { access } = await loggedIn();

    await change(access).expect(204);

    const rows: { to_address: string; template: string; payload: object }[] = await db.dataSource.query(
      `SELECT to_address, template, payload FROM email_outbox`,
    );
    expect(rows).toEqual([{ to_address: 'ana@example.com', template: 'password-changed', payload: {} }]);
  });

  it('has no GET route', async () => {
    expect((await request(server()).get('/api/v1/password/change')).status).toBe(404);
  });

  describe('bearer authentication', () => {
    it('answers one byte-identical 401 invalid_token with WWW-Authenticate for a missing, malformed and foreign token', async () => {
      const { access } = await loggedIn();
      const tampered = `${access.slice(0, -4)}AAAA`;

      const answers = [await change(undefined), await change('nonsense'), await change(tampered)];

      for (const answer of answers) {
        expect(answer.status).toBe(401);
        expect(answer.body).toEqual(INVALID_TOKEN);
        expect(answer.headers['www-authenticate']).toBe('Bearer');
        expect(answer.headers['access-control-allow-origin']).toBeUndefined();
        expect(fingerprint(answer)).toEqual(fingerprint(answers[0]!));
      }
      expect(await hashOf()).toBe(oldHash);
    });

    it('answers 401 before looking at the body, and touches no counter', async () => {
      const response = await change(undefined, { current_password: 5 });

      expect(response.status).toBe(401);
      expect(await counterRows()).toBe(0);
    });
  });

  describe('wrong current password', () => {
    it('is a 400 invalid_current_password, never a 401, and changes and revokes nothing', async () => {
      const { access, refresh: refreshToken } = await loggedIn();

      const response = await change(access, { current_password: 'wrong passphrase', new_password: NEW });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(INVALID_CURRENT);
      expect(await hashOf()).toBe(oldHash);
      expect((await refresh(shop, refreshToken)).status).toBe(200);
    });

    it('blocks the pair after the limit: the correct password gets the same 400 and nothing changes', async () => {
      const { access } = await loggedIn();
      for (let i = 0; i < PAIR_LIMIT; i += 1) await change(access, { current_password: 'wrong passphrase', new_password: NEW });

      const blocked = await change(access);

      expect(blocked.status).toBe(400);
      expect(blocked.body).toEqual(INVALID_CURRENT);
      expect(await hashOf()).toBe(oldHash);
    });

    it('feeds the login counters: wrong changes block the login from that IP, and wrong logins block the change', async () => {
      const first = await loggedIn();
      for (let i = 0; i < PAIR_LIMIT; i += 1) await change(first.access, { current_password: 'wrong passphrase', new_password: NEW });
      const blockedLogin = await login(OLD);
      expect(blockedLogin.status).toBe(401);
      expect(blockedLogin.body.error).toBe('invalid_credentials');

      await db.dataSource.query('TRUNCATE abuse_counters');
      const second = await loggedIn();
      for (let i = 0; i < PAIR_LIMIT; i += 1) await login('wrong passphrase');
      const blockedChange = await change(second.access);

      expect(blockedChange.status).toBe(400);
      expect(blockedChange.body).toEqual(INVALID_CURRENT);
    });
  });

  describe('input checks', () => {
    it('answers a weak new password with 400 invalid_password and no state change or counter', async () => {
      const { access, refresh: refreshToken } = await loggedIn();
      const rowsBefore = await counterRows();

      const weak = await change(access, { current_password: OLD, new_password: 'short' });

      expect(weak.status).toBe(400);
      expect(weak.body.error).toBe('invalid_password');
      expect(await counterRows()).toBe(rowsBefore);
      expect(await hashOf()).toBe(oldHash);
      expect((await refresh(shop, refreshToken)).status).toBe(200);
    });

    it('answers a missing or non-string field with 400 invalid_request', async () => {
      const { access } = await loggedIn();

      for (const body of [{}, { current_password: OLD }, { new_password: NEW }, { current_password: 5, new_password: NEW }]) {
        const response = await change(access, body);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid_request');
      }
    });
  });

  describe('CORS bound to the token audience', () => {
    it('answers a preflight from an active app origin', async () => {
      const response = await request(server())
        .options('/api/v1/password/change')
        .set('Origin', SHOP_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('grants the allow header to the own origin on success and on every 400', async () => {
      const { access } = await loggedIn();

      const wrong = await change(access, { current_password: 'wrong passphrase', new_password: NEW }).set('Origin', SHOP_ORIGIN);
      const weak = await change(access, { current_password: OLD, new_password: 'short' }).set('Origin', SHOP_ORIGIN);
      const malformed = await change(access, {}).set('Origin', SHOP_ORIGIN);
      const done = await change(access).set('Origin', SHOP_ORIGIN);

      for (const answer of [wrong, weak, malformed, done]) {
        expect(answer.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      }
      expect(done.status).toBe(204);
    });

    it("answers the generic 401 and no allow header for another app's origin, and changes nothing", async () => {
      const { access } = await loggedIn();

      const response = await change(access).set('Origin', BLOG_ORIGIN);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(INVALID_TOKEN);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(await hashOf()).toBe(oldHash);
    });
  });

  it('only changes the password of the account behind the token, in its own app', async () => {
    await addTestUser(app, { appId: blog.id, email: 'ana@example.com', passwordHash: oldHash });
    const { access } = await loggedIn();
    const blogSession = await loggedIn(blog);

    await change(access).expect(204);

    expect(await hashOf('ana@example.com', blog.id)).toBe(oldHash);
    expect((await refresh(blog, blogSession.refresh)).status).toBe(200);
  });
});
