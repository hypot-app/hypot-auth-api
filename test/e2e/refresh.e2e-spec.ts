import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { FixedClock } from '../../src/shared-kernel/clock';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { ACCESS_TOKEN_VERIFIER, type AccessTokenVerifier } from '../../src/token-lifecycle/domain/access-token';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { createTestApp } from '../support/create-test-app';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const PASSWORD = 'correct horse battery';
const INVALID_GRANT = { error: 'invalid_grant', message: 'The refresh token is invalid or has expired.' };
const REFRESH_IP_LIMIT = 8;

const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

describe('POST /api/v1/auth/refresh (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;
  let clock: FixedClock;

  const post = (body: unknown, origin?: string) => {
    const req = request(app.getHttpServer()).post('/api/v1/auth/refresh').send(body as object);
    return origin === undefined ? req : req.set('Origin', origin);
  };
  const refresh = (token: string, overrides: Record<string, unknown> = {}, origin?: string) =>
    post({ client_id: shop.clientId, refresh_token: token, ...overrides }, origin);
  const resetCounters = (): Promise<unknown> => db.dataSource.query('TRUNCATE abuse_counters');
  const rows = (sql: string, params: unknown[] = []): Promise<any[]> => db.dataSource.query(sql, params);

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
  /** Logs ana in to `target` over HTTP and returns the token pair the SPA would hold. */
  const loginTo = async (target: App, email = 'ana@example.com'): Promise<{ access: string; refresh: string }> => {
    const hash = await new LowCostPasswordHasher().hash(PASSWORD);
    const user = User.register({ id: randomUUID(), appId: target.id, email, passwordHash: hash, now: new Date() }).confirm(new Date());
    await new TypeOrmUserRepository(app.get(DataSource)).add(user);
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ client_id: target.clientId, email, password: PASSWORD })
      .expect(200);
    return { access: response.body.access_token, refresh: response.body.refresh_token };
  };
  const sessionState = async (): Promise<{ revoked_reason: string | null; last_used_at: Date; created_at: Date }[]> =>
    rows(`SELECT revoked_reason, last_used_at, created_at FROM auth_sessions ORDER BY created_at`);

  beforeAll(async () => {
    db = await startTestDatabase();
    clock = new FixedClock(new Date());
    app = await createTestApp({
      databaseUrl: db.url,
      clock,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({ refresh_ip: { limit: REFRESH_IP_LIMIT, windowSeconds: 900 } }),
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

  describe('success', () => {
    it('answers 200 with the login body shape, no cookie and no-store headers, and a token that verifies for the client', async () => {
      const first = await loginTo(shop);

      const response = await refresh(first.refresh);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['pragma']).toBe('no-cache');
      expect(Object.keys(response.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'token_type']);
      expect(response.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
      expect(response.body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.body.refresh_token).not.toBe(first.refresh);
      const verifier = app.get<AccessTokenVerifier>(ACCESS_TOKEN_VERIFIER);
      expect(await verifier.verify(response.body.access_token, { audience: shop.clientId })).toMatchObject({ ok: true });
    });

    it('keeps rotating inside one session, with hashes only in the table', async () => {
      const first = await loginTo(shop);

      const second = await refresh(first.refresh).expect(200);
      const third = await refresh(second.body.refresh_token).expect(200);

      expect(await sessionState()).toHaveLength(1);
      const tokens = await rows(`SELECT token_hash, consumed_at, replaced_by_hash, consumed_ip_hash FROM refresh_tokens ORDER BY created_at`);
      expect(tokens).toHaveLength(3);
      expect(tokens[0].token_hash).toEqual(sha256(first.refresh));
      expect(tokens[0].replaced_by_hash).toEqual(sha256(second.body.refresh_token));
      expect(tokens[0].consumed_ip_hash).toHaveLength(32);
      expect(tokens[1].replaced_by_hash).toEqual(sha256(third.body.refresh_token));
      expect(tokens[2].consumed_at).toBeNull();
      const dump = JSON.stringify(await rows(`SELECT * FROM refresh_tokens`));
      for (const raw of [first.refresh, second.body.refresh_token, third.body.refresh_token]) expect(dump).not.toContain(raw);
      // The client address is stored hashed as well.
      expect(dump).not.toContain('127.0.0.1');
    });

    it('updates last_used_at of the session and leaves its absolute expiry alone', async () => {
      const first = await loginTo(shop);
      const [before] = await rows(`SELECT last_used_at, expires_at FROM auth_sessions`);
      clock.advanceMs(60_000);

      await refresh(first.refresh).expect(200);

      const [after] = await rows(`SELECT last_used_at, expires_at FROM auth_sessions`);
      expect(after.last_used_at.getTime()).toBeGreaterThan(before.last_used_at.getTime());
      expect(after.expires_at).toEqual(before.expires_at);
    });

    it('lets the browser read it from the bound origin, with no credentials header', async () => {
      const first = await loginTo(shop);

      const response = await refresh(first.refresh, {}, SHOP_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    });
  });

  describe('invalid_grant', () => {
    it('is byte-identical for an unknown token, a malformed one, a token of another app and an expired one', async () => {
      const ana = await loginTo(shop);
      const other = await loginTo(blog, 'bob@example.com');
      await rows(`UPDATE refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, [sha256(ana.refresh)]);
      const fingerprint = (response: request.Response) => {
        const { date: _date, ...headers } = response.headers;
        return { status: response.status, body: response.body, headers };
      };

      const outcomes = [
        fingerprint(await refresh(randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 11))),
        fingerprint(await refresh('not a token!')),
        fingerprint(await refresh(other.refresh)),
        fingerprint(await refresh(ana.refresh)),
      ];

      expect(outcomes[0]!.status).toBe(401);
      expect(outcomes[0]!.body).toEqual(INVALID_GRANT);
      expect(outcomes[0]!.headers['cache-control']).toBe('no-store');
      expect(outcomes[0]!.headers['pragma']).toBe('no-cache');
      for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual([null, null]);
    });

    it('lets the browser read the 401 when the origin is bound, and withholds it when it is not', async () => {
      const bound = await refresh('not a token!', {}, SHOP_ORIGIN);
      const foreign = await refresh('not a token!', {}, BLOG_ORIGIN);

      expect(bound.status).toBe(401);
      expect(bound.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(foreign.status).toBe(401);
      expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does not revoke the session of a token presented under another app', async () => {
      const ana = await loginTo(shop);

      const response = await refresh(ana.refresh, { client_id: blog.clientId });

      expect(response.status).toBe(401);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual([null]);
      await refresh(ana.refresh).expect(200);
    });
  });

  describe('origin binding', () => {
    it.each([
      ["another app's origin", BLOG_ORIGIN],
      ['an origin no app owns', 'https://evil.example'],
    ])('answers a valid token from %s with invalid_grant, no allow header, and leaves the token unconsumed', async (_name, origin) => {
      const ana = await loginTo(shop);

      const response = await refresh(ana.refresh, {}, origin);

      expect(response.status).toBe(401);
      expect(response.body).toEqual(INVALID_GRANT);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      const [token] = await rows(`SELECT consumed_at FROM refresh_tokens`);
      expect(token.consumed_at).toBeNull();
      await refresh(ana.refresh, {}, SHOP_ORIGIN).expect(200);
    });
  });

  describe('invalid_client and malformed body', () => {
    it('answers an unknown client with 400 invalid_client and no allow header, no-store included', async () => {
      const ana = await loginTo(shop);

      const response = await refresh(ana.refresh, { client_id: 'app_missing' }, SHOP_ORIGIN);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'invalid_client' });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers an inactive client with 400 invalid_client', async () => {
      const parked = await registerApp('Parked', 'https://parked.example', 'inactive');

      const response = await refresh('not a token!', { client_id: parked.clientId });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: 'invalid_client' });
    });

    it.each([
      ['a missing refresh_token', { client_id: 'x' }],
      ['a non-string refresh_token', { client_id: 'x', refresh_token: 12345 }],
      ['a missing client_id', { refresh_token: 'abc' }],
      ['an empty body', {}],
    ])('answers %s with 400 invalid_request, readable from an app origin', async (_name, body) => {
      const response = await post(body, SHOP_ORIGIN);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'invalid_request', message: 'client_id and refresh_token must be strings' });
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['cache-control']).toBe('no-store');
    });
  });

  describe('reuse', () => {
    it('revokes the session on a replay and then refuses the successor too', async () => {
      const first = await loginTo(shop);
      const second = await refresh(first.refresh).expect(200);
      clock.advanceMs(11_000);

      const replay = await refresh(first.refresh);
      const successor = await refresh(second.body.refresh_token);

      expect(replay.status).toBe(401);
      expect(replay.body).toEqual(INVALID_GRANT);
      expect(successor.status).toBe(401);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual(['reuse_detected']);
    });
  });

  describe('reuse grace window', () => {
    it('forgives a lost response: the retry of the old token from the same IP gets a fresh pair and the session survives', async () => {
      const first = await loginTo(shop);
      const lost = await refresh(first.refresh).expect(200);
      clock.advanceMs(3_000);

      const retry = await refresh(first.refresh, {}, SHOP_ORIGIN);

      expect(retry.status).toBe(200);
      expect(retry.headers['cache-control']).toBe('no-store');
      expect(retry.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(Object.keys(retry.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'token_type']);
      expect(retry.body.refresh_token).not.toBe(lost.body.refresh_token);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual([null]);
      // The lost pair is dead, the retried one works.
      expect((await refresh(retry.body.refresh_token).expect(200)).status).toBe(200);
      const dump = JSON.stringify(await rows(`SELECT * FROM refresh_tokens`));
      for (const raw of [first.refresh, lost.body.refresh_token, retry.body.refresh_token]) expect(dump).not.toContain(raw);
    });

    it('logs the user out when the same retry comes after the window', async () => {
      const first = await loginTo(shop);
      await refresh(first.refresh).expect(200);
      clock.advanceMs(11_000);

      const retry = await refresh(first.refresh);

      expect(retry.status).toBe(401);
      expect(retry.body).toEqual(INVALID_GRANT);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual(['reuse_detected']);
    });

    it('logs the user out when the successor R2 is used after a grace retry', async () => {
      const first = await loginTo(shop);
      const lost = await refresh(first.refresh).expect(200);
      clock.advanceMs(1_000);
      await refresh(first.refresh).expect(200);

      const stale = await refresh(lost.body.refresh_token);

      expect(stale.status).toBe(401);
      expect((await sessionState()).map((s) => s.revoked_reason)).toEqual(['reuse_detected']);
    });
  });

  describe('refresh_ip limit', () => {
    it('answers 429 with an integer Retry-After and no-store, the same for a valid and an invalid token, and consumes nothing', async () => {
      const ana = await loginTo(shop);
      for (let i = 0; i < REFRESH_IP_LIMIT; i += 1) await refresh('not a token!');

      const valid = await refresh(ana.refresh, {}, SHOP_ORIGIN);
      const invalid = await refresh('not a token!', {}, SHOP_ORIGIN);

      for (const response of [valid, invalid]) {
        expect(response.status).toBe(429);
        expect(response.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
        expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['pragma']).toBe('no-cache');
        expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      }
      const [token] = await rows(`SELECT consumed_at FROM refresh_tokens`);
      expect(token.consumed_at).toBeNull();
      await resetCounters();
      await refresh(ana.refresh).expect(200);
    });

    it('answers 429 before it looks the client up, so an unknown client is limited as well', async () => {
      for (let i = 0; i < REFRESH_IP_LIMIT; i += 1) await refresh('not a token!', { client_id: `app_${randomUUID()}` });

      const response = await refresh('not a token!', { client_id: `app_${randomUUID()}` });

      expect(response.status).toBe(429);
    });
  });
});
