import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { decodeProtectedHeader } from 'jose';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { ClientRef } from '../../src/abuse-protection/domain/client-ref';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { ACCESS_TOKEN_TYP, ACCESS_TOKEN_VERIFIER, type AccessTokenVerifier } from '../../src/token-lifecycle/domain/access-token';
import { User } from '../../src/user-accounts/domain/user';
import { BcryptPasswordHasher } from '../../src/user-accounts/infrastructure/bcrypt-password-hasher';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { createTestApp } from '../support/create-test-app';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const PASSWORD = 'correct horse battery';
const GENERIC_401 = { error: 'invalid_credentials', message: 'Email or password is incorrect.' };
const LOGIN_IP_LIMIT = 10;
const PAIR_LIMIT = 3;
const ACCOUNT_LIMIT = 4;
const DAY_MS = 86_400_000;

describe('POST /api/v1/auth/login (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;
  /** Cost 4: the bulk tests pay for bcrypt in the logins only, and almost nothing there. */
  let passwordHash: string;
  /** Cost 12, what production stores. Used by the one suite that runs the real hasher end to end. */
  let productionHash: string;
  const verifySpy = jest.spyOn(BcryptPasswordHasher.prototype, 'verify');

  const loginOn = (target: INestApplication, body: Record<string, unknown>, origin?: string) => {
    const req = request(target.getHttpServer()).post('/api/v1/auth/login').send(body);
    return origin === undefined ? req : req.set('Origin', origin);
  };
  const login = (body: Record<string, unknown>, origin?: string) => loginOn(app, body, origin);
  const credentials = (overrides: Record<string, unknown> = {}) => ({
    client_id: shop.clientId,
    email: 'ana@example.com',
    password: PASSWORD,
    ...overrides,
  });
  const count = async (table: string): Promise<number> =>
    Number((await db.dataSource.query(`SELECT count(*) AS n FROM ${table}`))[0].n);
  const resetCounters = (): Promise<unknown> => db.dataSource.query('TRUNCATE abuse_counters');

  const registerApp = async (name: string, origin: string): Promise<App> => {
    const now = new Date();
    const created = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name,
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [origin],
      emailFrom: null,
      emailConfirmationUrl: null,
      passwordResetUrl: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(created);
    return created;
  };
  const addUser = async (appId: string, email: string, confirmed = true, hash = passwordHash): Promise<User> => {
    const registered = User.register({ id: randomUUID(), appId, email, passwordHash: hash, now: new Date() });
    const user = confirmed ? registered.confirm(new Date()) : registered;
    await new TypeOrmUserRepository(app.get(DataSource)).add(user);
    return user;
  };
  /** Status, body and every header except the clock. */
  const fingerprint = (response: request.Response) => {
    const { date: _date, ...headers } = response.headers;
    return { status: response.status, body: response.body, headers };
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({
        login_ip: { limit: LOGIN_IP_LIMIT },
        login_account_ip: { limit: PAIR_LIMIT, blockSeconds: 900 },
        login_account: { limit: ACCOUNT_LIMIT, blockSeconds: 900 },
      }),
    });
    passwordHash = await new LowCostPasswordHasher().hash(PASSWORD);
    productionHash = await new BcryptPasswordHasher().hash(PASSWORD);
  }, 180_000);

  afterAll(async () => {
    verifySpy.mockRestore();
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    verifySpy.mockClear();
    [shop, blog] = [await registerApp('Shop', SHOP_ORIGIN), await registerApp('Blog', BLOG_ORIGIN)];
  });

  describe('success', () => {
    it('answers 200 with the token pair as JSON, an RS256 at+jwt access token for the client, and no cookie', async () => {
      const user = await addUser(shop.id, 'ana@example.com');

      const response = await login(credentials({ email: ' ANA@Example.com ' }));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(Object.keys(response.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'token_type']);
      expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
      expect(response.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const header = decodeProtectedHeader(response.body.access_token);
      expect(header).toMatchObject({ alg: 'RS256', typ: ACCESS_TOKEN_TYP });
      const verifier = app.get<AccessTokenVerifier>(ACCESS_TOKEN_VERIFIER);
      const claims = await verifier.verify(response.body.access_token, { audience: shop.clientId });
      expect(claims).toMatchObject({ ok: true, value: { sub: user.id, aud: shop.clientId } });
    });

    it('stores a session bound to the app and user and the refresh token only as its SHA-256', async () => {
      const user = await addUser(shop.id, 'ana@example.com');
      const before = Date.now();

      const response = await login(credentials());

      const sessions = await db.dataSource.query(`SELECT id, app_id, user_id, expires_at, revoked_at FROM auth_sessions`);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ app_id: shop.id, user_id: user.id, revoked_at: null });
      expect(sessions[0].expires_at.getTime() - before).toBeGreaterThan(30 * DAY_MS - 60_000);
      expect(sessions[0].expires_at.getTime() - before).toBeLessThan(30 * DAY_MS + 60_000);

      const tokens = await db.dataSource.query(`SELECT token_hash, session_id, expires_at, consumed_at FROM refresh_tokens`);
      expect(tokens).toHaveLength(1);
      expect(tokens[0].session_id).toBe(sessions[0].id);
      expect(tokens[0].consumed_at).toBeNull();
      expect(tokens[0].token_hash).toEqual(createHash('sha256').update(response.body.refresh_token).digest());
      expect(tokens[0].expires_at.getTime() - before).toBeGreaterThan(7 * DAY_MS - 60_000);
      expect(tokens[0].expires_at.getTime() - before).toBeLessThan(7 * DAY_MS + 60_000);
      expect(JSON.stringify(await db.dataSource.query(`SELECT * FROM refresh_tokens`))).not.toContain(response.body.refresh_token);
    });

    it('lets the browser read it from the bound origin, with no credentials header', async () => {
      await addUser(shop.id, 'ana@example.com');

      const response = await login(credentials(), SHOP_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['vary']).toMatch(/Origin/);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('the generic failure', () => {
    it('is byte-identical (status, body, headers) for every cause, never a 429, with one bcrypt run when the limits let it through and none when they do not', async () => {
      await addUser(shop.id, 'ana@example.com');
      await addUser(shop.id, 'pending@example.com', false);
      await addUser(shop.id, 'locked@example.com');
      await addUser(shop.id, 'blocked@example.com');
      const guard = app.get(AbuseGuard, { strict: false });
      const nothing = async (): Promise<void> => undefined;
      const cases: { name: string; prepare: () => Promise<void>; send: () => request.Test; verifies: number }[] = [
        { name: 'unknown email', prepare: nothing, send: () => login(credentials({ email: 'nobody@example.com' })), verifies: 1 },
        { name: 'wrong password', prepare: nothing, send: () => login(credentials({ password: 'wrong password!!' })), verifies: 1 },
        { name: 'unconfirmed account, right password', prepare: nothing, send: () => login(credentials({ email: 'pending@example.com' })), verifies: 1 },
        { name: 'unknown client_id', prepare: nothing, send: () => login(credentials({ client_id: `app_${randomUUID()}` })), verifies: 1 },
        {
          name: 'locked account, right password',
          prepare: async () => {
            for (let i = 1; i <= ACCOUNT_LIMIT + 1; i += 1) {
              await guard.beginLoginAttempt(ClientRef.resolved(shop), 'locked@example.com', ClientIp.from(`198.51.100.${i}`, undefined));
            }
          },
          send: () => login(credentials({ email: 'locked@example.com' })),
          verifies: 0,
        },
        {
          name: 'blocked (account, IP) pair, right password',
          prepare: async () => {
            for (let i = 0; i < PAIR_LIMIT; i += 1) await login(credentials({ email: 'blocked@example.com', password: 'wrong password!!' }));
          },
          send: () => login(credentials({ email: 'blocked@example.com' })),
          verifies: 0,
        },
        {
          name: 'rate-limited IP',
          prepare: async () => {
            for (let i = 0; i < LOGIN_IP_LIMIT; i += 1) await login(credentials({ email: `${randomUUID()}@example.com` }));
          },
          send: () => login(credentials()),
          verifies: 0,
        },
      ];

      const outcomes: { name: string; verifies: number; response: ReturnType<typeof fingerprint> }[] = [];
      for (const { name, prepare, send } of cases) {
        await resetCounters();
        await prepare();
        verifySpy.mockClear();
        const response = await send();
        outcomes.push({ name, verifies: verifySpy.mock.calls.length, response: fingerprint(response) });
      }

      const reference = outcomes[0]!.response;
      expect(reference.status).toBe(401);
      expect(reference.body).toEqual(GENERIC_401);
      expect(reference.headers['www-authenticate']).toBeUndefined();
      expect(reference.headers['retry-after']).toBeUndefined();
      expect(outcomes.map(({ name, response }) => ({ name, response }))).toEqual(
        cases.map(({ name }) => ({ name, response: reference })),
      );
      expect(outcomes.map(({ name, verifies }) => ({ name, verifies }))).toEqual(
        cases.map(({ name, verifies }) => ({ name, verifies })),
      );
      expect(await count('auth_sessions')).toBe(0);
    });

    it('shares ONE login_ip limit between random client_id values and does not grow the counter table', async () => {
      const statuses: number[] = [];
      // A fresh email each time keeps the (account, IP) lockout out of the way, so only login_ip decides.
      for (let i = 0; i < LOGIN_IP_LIMIT + 3; i += 1) {
        statuses.push((await login(credentials({ client_id: `app_${randomUUID()}`, email: `${randomUUID()}@example.com` }))).status);
      }

      expect(statuses).toEqual(Array(LOGIN_IP_LIMIT + 3).fill(401));
      expect(verifySpy).toHaveBeenCalledTimes(LOGIN_IP_LIMIT);
      const rows = await db.dataSource.query(`SELECT scope FROM abuse_counters WHERE scope = 'login_ip'`);
      expect(rows).toHaveLength(1);
    });

    it('lets the browser read it from the bound origin, because the binding passed', async () => {
      const response = await login(credentials({ password: 'wrong password!!' }), SHOP_ORIGIN);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(GENERIC_401);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it.each([
      ["another app's origin", BLOG_ORIGIN],
      ['an origin no app owns', 'https://evil.example'],
    ])('answers the correct credentials from %s with the same 401, no allow header and no session', async (_name, origin) => {
      await addUser(shop.id, 'ana@example.com');
      const reference = fingerprint(await login(credentials({ email: 'nobody@example.com' })));
      await resetCounters();

      const response = await login(credentials(), origin);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(reference.body);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(await count('auth_sessions')).toBe(0);
    });

    it('does not log an account of one app in through another app, even with the same email and password', async () => {
      await addUser(blog.id, 'ana@example.com');

      const crossApp = await login(credentials({ client_id: shop.clientId }));

      expect(crossApp.status).toBe(401);
      expect(crossApp.body).toEqual(GENERIC_401);
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(await count('auth_sessions')).toBe(0);
      expect(await count('refresh_tokens')).toBe(0);

      // Control: the very same credentials work in the app where the account lives.
      const home = await login(credentials({ client_id: blog.clientId }));
      expect(home.status).toBe(200);
      expect(await count('auth_sessions')).toBe(1);
    });

    it('answers an unknown client_id from an app origin with the same 401 and no allow header', async () => {
      const response = await login(credentials({ client_id: 'app_missing' }), SHOP_ORIGIN);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(GENERIC_401);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('malformed body', () => {
    it.each([
      ['a missing email', { client_id: 'x', password: PASSWORD }],
      ['a non-string password', { client_id: 'x', email: 'ana@example.com', password: 12345678 }],
      ['a missing client_id', { email: 'ana@example.com', password: PASSWORD }],
      ['an empty body', {}],
    ])('answers %s with a 400 that says nothing about accounts, readable from an app origin', async (_name, body) => {
      const response = await login(body, SHOP_ORIGIN);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request', message: 'client_id, email and password must be strings' });
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('grants no allow header to a 400 from an origin no app owns', async () => {
      const response = await login({}, 'https://evil.example');

      expect(response.status).toBe(400);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('with the production hasher (bcrypt cost 12)', () => {
    let realApp: INestApplication;

    beforeAll(async () => {
      realApp = await createTestApp({ databaseUrl: db.url });
    }, 60_000);

    afterAll(async () => {
      await realApp?.close();
    });

    it('logs in and fails generically end to end, comparing against a cost-12 hash and a cost-12 dummy', async () => {
      expect(productionHash).toMatch(/^\$2[aby]\$12\$/);
      await addUser(shop.id, 'ana@example.com', true, productionHash);

      const ok = await loginOn(realApp, credentials());
      const wrong = await loginOn(realApp, credentials({ password: 'wrong password!!' }));
      const unknown = await loginOn(realApp, credentials({ email: 'nobody@example.com' }));

      expect(ok.status).toBe(200);
      expect(ok.body.access_token).toEqual(expect.any(String));
      expect([wrong.status, unknown.status]).toEqual([401, 401]);
      expect([wrong.body, unknown.body]).toEqual([GENERIC_401, GENERIC_401]);
      expect(verifySpy).toHaveBeenCalledTimes(3);
      expect(await count('auth_sessions')).toBe(1);
    });
  });

  it('answers 503 and issues nothing when the limiter store is down', async () => {
    await addUser(shop.id, 'ana@example.com');
    await db.dataSource.query('ALTER TABLE abuse_counters RENAME TO abuse_counters_off');
    try {
      const response = await login(credentials(), SHOP_ORIGIN);

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: 'temporarily_unavailable',
        message: 'The service is temporarily unavailable. Try again later.',
      });
      expect(await count('auth_sessions')).toBe(0);
    } finally {
      await db.dataSource.query('ALTER TABLE abuse_counters_off RENAME TO abuse_counters');
    }
  });
});
