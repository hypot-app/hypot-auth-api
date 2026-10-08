import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { ACCESS_TOKEN_VERIFIER, type AccessTokenVerifier } from '../../src/token-lifecycle/domain/access-token';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { createTestApp } from '../support/create-test-app';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const PASSWORD = 'correct horse battery';

describe('POST /api/v1/auth/logout (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let clock: FixedClock;
  let shop: App;
  let blog: App;

  const post = (path: string, body: unknown, origin?: string) => {
    const req = request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send(body as object);
    return origin === undefined ? req : req.set('Origin', origin);
  };
  const logout = (token: string, overrides: Record<string, unknown> = {}, origin?: string) =>
    post('logout', { client_id: shop.clientId, refresh_token: token, ...overrides }, origin);
  const refresh = (token: string, client = shop) => post('refresh', { client_id: client.clientId, refresh_token: token });
  const rows = (sql: string): Promise<any[]> => db.dataSource.query(sql);
  const reasons = async (): Promise<(string | null)[]> =>
    (await rows(`SELECT s.revoked_reason FROM auth_sessions s JOIN users u ON u.id = s.user_id ORDER BY u.email`)).map(
      (row) => row.revoked_reason,
    );
  const fingerprint = (response: request.Response) => {
    const { date: _date, ...headers } = response.headers;
    return { status: response.status, body: response.body, text: response.text, headers };
  };

  const registerApp = async (name: string, origin: string, status: 'active' | 'inactive' = 'active'): Promise<App> => {
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
      status,
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(created);
    return created;
  };
  const loginTo = async (target: App, email = 'ana@example.com'): Promise<{ access: string; refresh: string }> => {
    const hash = await new LowCostPasswordHasher().hash(PASSWORD);
    const user = User.register({ id: randomUUID(), appId: target.id, email, passwordHash: hash, now: new Date() }).confirm(new Date());
    await new TypeOrmUserRepository(app.get(DataSource)).add(user);
    const response = await post('login', { client_id: target.clientId, email, password: PASSWORD }).expect(200);
    return { access: response.body.access_token, refresh: response.body.refresh_token };
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    clock = new FixedClock(new Date());
    app = await createTestApp({
      databaseUrl: db.url,
      clock,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({ refresh_ip: { limit: 5, windowSeconds: 900 } }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    [shop, blog] = [await registerApp('Shop', SHOP_ORIGIN), await registerApp('Blog', BLOG_ORIGIN)];
  });

  it('answers 204 with no body and no-store headers, revokes the session, and makes the next refresh fail', async () => {
    const session = await loginTo(shop);

    const response = await logout(session.refresh);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['pragma']).toBe('no-cache');
    expect(await reasons()).toEqual(['logout']);
    expect((await refresh(session.refresh)).status).toBe(401);
  });

  it('leaves an access token issued before the logout valid until its exp', async () => {
    const session = await loginTo(shop);

    await logout(session.refresh).expect(204);

    const verifier = app.get<AccessTokenVerifier>(ACCESS_TOKEN_VERIFIER);
    expect(await verifier.verify(session.access, { audience: shop.clientId })).toMatchObject({ ok: true });
  });

  it('ends the session through its used token as well, so the current successor stops working', async () => {
    const first = await loginTo(shop);
    const second = await refresh(first.refresh).expect(200);

    await logout(first.refresh).expect(204);

    expect(await reasons()).toEqual(['logout']);
    expect((await refresh(second.body.refresh_token)).status).toBe(401);
  });

  it('answers a byte-identical 204 for active, revoked, expired, unknown, malformed and other-app tokens', async () => {
    const active = await loginTo(shop, 'a@example.com');
    const revoked = await loginTo(shop, 'b@example.com');
    await logout(revoked.refresh).expect(204);
    const expired = await loginTo(shop, 'c@example.com');
    await rows(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = (SELECT token_hash FROM refresh_tokens ORDER BY created_at DESC LIMIT 1)`);
    const otherApp = await loginTo(blog, 'd@example.com');

    const outcomes = [
      fingerprint(await logout(active.refresh)),
      fingerprint(await logout(revoked.refresh)),
      fingerprint(await logout(expired.refresh)),
      fingerprint(await logout(randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 11))),
      fingerprint(await logout('not a token!')),
      fingerprint(await logout(otherApp.refresh)),
    ];

    expect(outcomes[0]!.status).toBe(204);
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
  });

  it('revokes only the session of the token it was given', async () => {
    const mine = await loginTo(shop, 'a@example.com');
    const other = await loginTo(shop, 'b@example.com');

    await logout(mine.refresh).expect(204);

    expect(await reasons()).toEqual(['logout', null]);
    expect((await refresh(other.refresh)).status).toBe(200);
  });

  it('revokes nothing for a token that belongs to another app', async () => {
    const session = await loginTo(blog);

    await logout(session.refresh).expect(204);

    expect(await reasons()).toEqual([null]);
    expect((await refresh(session.refresh, blog)).status).toBe(200);
  });

  describe('origin binding', () => {
    it('revokes from the bound origin and lets the browser read the 204', async () => {
      const session = await loginTo(shop);

      const response = await logout(session.refresh, {}, SHOP_ORIGIN);

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(await reasons()).toEqual(['logout']);
    });

    it.each([
      ["another app's origin", BLOG_ORIGIN],
      ['an origin no app owns', 'https://evil.example'],
    ])('answers 204 from %s with no allow header, and revokes nothing', async (_name, origin) => {
      const session = await loginTo(shop);

      const response = await logout(session.refresh, {}, origin);

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(await reasons()).toEqual([null]);
      expect((await refresh(session.refresh)).status).toBe(200);
    });

    it('answers 204 for an unknown or inactive client with no allow header, and revokes nothing', async () => {
      const session = await loginTo(shop);
      const parked = await registerApp('Parked', 'https://parked.example', 'inactive');

      const unknown = await logout(session.refresh, { client_id: 'app_missing' }, SHOP_ORIGIN);
      const inactive = await logout(session.refresh, { client_id: parked.clientId }, 'https://parked.example');

      for (const response of [unknown, inactive]) {
        expect(response.status).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
      expect(await reasons()).toEqual([null]);
    });
  });

  describe('malformed body', () => {
    it.each([
      ['a missing refresh_token', { client_id: 'x' }],
      ['a non-string refresh_token', { client_id: 'x', refresh_token: 12345 }],
      ['a missing client_id', { refresh_token: 'abc' }],
      ['an empty body', {}],
    ])('answers %s with 400 invalid_request, readable from an app origin, and revokes nothing', async (_name, body) => {
      const session = await loginTo(shop);

      const response = await post('logout', body, SHOP_ORIGIN);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request', message: 'client_id and refresh_token must be strings' });
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(await reasons()).toEqual([null]);
      expect(session.refresh).toBeDefined();
    });
  });

  it('has no limiter: many calls in a row stay 204', async () => {
    for (let i = 0; i < 12; i += 1) await logout('not a token!').expect(204);
  });
});
