import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import type { App } from '../../src/app-registry/domain/app';
import { FixedClock } from '../../src/shared-kernel/clock';
import { createTestApp } from '../support/create-test-app';
import { addTestUser, fingerprint, registerTestApp } from '../support/e2e-fixtures';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const OLD_PASSWORD = 'old passphrase';
const NEW_PASSWORD = 'a brand new passphrase';
const RESET_IP_LIMIT = 6;
const INVALID_LINK = { error: 'invalid_or_expired_link', message: 'The reset link is invalid or has expired' };
const HOUR_MS = 3_600_000;

describe('POST /api/v1/password/reset (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let clock: FixedClock;
  let shop: App;
  let blog: App;
  let oldHash: string;

  const server = () => app.getHttpServer();
  const reset = (token: unknown, newPassword: unknown = NEW_PASSWORD) =>
    request(server()).post('/api/v1/password/reset').send({ token, new_password: newPassword });
  const login = (clientId: string, email: string, password: string) =>
    request(server()).post('/api/v1/auth/login').send({ client_id: clientId, email, password });
  const refresh = (clientId: string, refreshToken: string) =>
    request(server()).post('/api/v1/auth/refresh').send({ client_id: clientId, refresh_token: refreshToken });
  /** Asks for a reset through the real endpoint and reads the token from the queued email. */
  const forgotToken = async (email = 'ana@example.com', client = shop): Promise<string> => {
    await request(server()).post('/api/v1/password/forgot').send({ client_id: client.clientId, email }).expect(202);
    const rows: { payload: { token: string } }[] = await db.dataSource.query(
      `SELECT payload FROM email_outbox WHERE template = 'password-reset' AND to_address = $1 ORDER BY created_at DESC, id LIMIT 1`,
      [email],
    );
    return rows[0]!.payload.token;
  };
  const hashOf = async (email: string): Promise<string> =>
    (await db.dataSource.query(`SELECT password_hash FROM users WHERE email = $1`, [email]))[0].password_hash;

  beforeAll(async () => {
    db = await startTestDatabase();
    clock = new FixedClock(new Date());
    // The production hasher (cost 12): the test asserts the stored hash. Seeded users carry a cost-4 hash,
    // which bcrypt still verifies quickly.
    app = await createTestApp({
      databaseUrl: db.url,
      clock,
      abusePolicies: resolvePolicies({ reset_ip: { limit: RESET_IP_LIMIT, windowSeconds: 3600 } }),
    });
    oldHash = await new LowCostPasswordHasher().hash(OLD_PASSWORD);
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

  it('answers 204 with no body and no Location, stores a cost-12 hash and revokes both sessions', async () => {
    const first = (await login(shop.clientId, 'ana@example.com', OLD_PASSWORD).expect(200)).body.refresh_token;
    const second = (await login(shop.clientId, 'ana@example.com', OLD_PASSWORD).expect(200)).body.refresh_token;
    const token = await forgotToken();

    const response = await reset(token);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.headers['location']).toBeUndefined();
    expect(await hashOf('ana@example.com')).toMatch(/^\$2b\$12\$/);
    for (const refreshToken of [first, second]) {
      const refreshed = await refresh(shop.clientId, refreshToken);
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.error).toBe('invalid_grant');
    }
    expect((await login(shop.clientId, 'ana@example.com', NEW_PASSWORD)).status).toBe(200);
    expect((await login(shop.clientId, 'ana@example.com', OLD_PASSWORD)).status).toBe(401);
  });

  it('has no GET route', async () => {
    expect((await request(server()).get('/api/v1/password/reset')).status).toBe(404);
  });

  it('answers a used, expired, superseded, unknown and malformed token with one identical 400', async () => {
    const used = await forgotToken();
    await reset(used).expect(204);
    // Three emails per address and hour is the cap: the used token, the one that gets superseded and the one that expires.
    const superseded = await forgotToken();
    const expired = await forgotToken();
    clock.advanceMs(HOUR_MS);

    const answers = [
      await reset(used),
      await reset(superseded),
      await reset(expired),
      await reset('u'.repeat(43)),
      await reset('not a token!'),
    ];

    for (const answer of answers) {
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual(INVALID_LINK);
    }
    for (const answer of answers) expect(fingerprint(answer)).toEqual(fingerprint(answers[0]!));
    expect(await hashOf('ana@example.com')).toMatch(/^\$2b\$12\$/);
  });

  it('rejects a weak password with 400 invalid_password and keeps the token usable', async () => {
    const token = await forgotToken();

    const weak = await reset(token, 'short');

    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe('invalid_password');
    expect(await hashOf('ana@example.com')).toBe(oldHash);
    expect((await reset(token)).status).toBe(204);
  });

  it('answers a malformed body with 400 invalid_request', async () => {
    for (const body of [{}, { token: 'x' }, { new_password: NEW_PASSWORD }, { token: 5, new_password: NEW_PASSWORD }]) {
      const response = await request(server()).post('/api/v1/password/reset').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    }
  });

  it('does not touch the password of another account or another app with the same email', async () => {
    await addTestUser(app, { appId: blog.id, email: 'ana@example.com', passwordHash: oldHash });
    await addTestUser(app, { appId: shop.id, email: 'bo@example.com', passwordHash: oldHash });
    const bo = (await login(shop.clientId, 'bo@example.com', OLD_PASSWORD).expect(200)).body.refresh_token;

    await reset(await forgotToken()).expect(204);

    const rows: { password_hash: string }[] = await db.dataSource.query(
      `SELECT password_hash FROM users WHERE email <> 'ana@example.com' OR app_id = $1`,
      [blog.id],
    );
    expect(rows.map((row) => row.password_hash)).toEqual([oldHash, oldHash]);
    expect((await refresh(shop.clientId, bo)).status).toBe(200);
  });

  it('limits per IP with 429 and an integer Retry-After, identical for valid and invalid tokens, leaving the token usable', async () => {
    const token = await forgotToken();
    for (let i = 0; i < RESET_IP_LIMIT; i += 1) await reset('w'.repeat(43)).expect(400);

    const valid = await reset(token);
    const invalid = await reset('w'.repeat(43));

    expect(valid.status).toBe(429);
    expect(valid.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(valid.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    expect(fingerprint(invalid)).toEqual(fingerprint(valid));
    expect(await hashOf('ana@example.com')).toBe(oldHash);
  });

  describe('CORS bound through the token', () => {
    it('answers a preflight from an active app origin', async () => {
      const response = await request(server())
        .options('/api/v1/password/reset')
        .set('Origin', SHOP_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('grants the allow header on success from the own origin', async () => {
      const response = await reset(await forgotToken()).set('Origin', SHOP_ORIGIN);

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it("refuses another app's origin with the generic 400 and no allow header, and leaves the token usable", async () => {
      const token = await forgotToken();

      const wrong = await reset(token).set('Origin', BLOG_ORIGIN);

      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual(INVALID_LINK);
      expect(wrong.headers['access-control-allow-origin']).toBeUndefined();
      expect(await hashOf('ana@example.com')).toBe(oldHash);
      expect((await reset(token).set('Origin', SHOP_ORIGIN)).status).toBe(204);
    });

    it('grants the allow header on the failure of a token that belongs to the own app, and not on an unknown token', async () => {
      const token = await forgotToken();
      await reset(token).expect(204);

      const used = await reset(token).set('Origin', SHOP_ORIGIN);
      const unknown = await reset('k'.repeat(43)).set('Origin', SHOP_ORIGIN);

      expect(used.status).toBe(400);
      expect(used.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(unknown.status).toBe(400);
      expect(unknown.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('lets the browser read a weak-password 400 and a malformed-body 400 from an active app origin', async () => {
      const token = await forgotToken();

      const weak = await reset(token, 'short').set('Origin', SHOP_ORIGIN);
      const malformed = await request(server()).post('/api/v1/password/reset').send({}).set('Origin', SHOP_ORIGIN);

      expect(weak.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(malformed.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });
  });
});
