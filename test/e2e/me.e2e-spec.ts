import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { SignJWT } from 'jose';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { ACCESS_TOKEN_ISSUER, type AccessTokenIssuer } from '../../src/token-lifecycle/domain/access-token';
import { KEY_STORE, type KeyStore } from '../../src/token-lifecycle/domain/key-store';
import { JwkSetKeyStore } from '../../src/token-lifecycle/infrastructure/jwk-set-key-store';
import { generateKeySet } from '../../src/token-lifecycle/infrastructure/signing-key-generator';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { createTestApp } from '../support/create-test-app';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const INVALID_TOKEN_BODY = { error: 'invalid_token', message: 'Missing or invalid access token' };

describe('GET /api/v1/me (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let clock: FixedClock;
  let shop: App;
  let blog: App;
  let parked: App;

  const me = (authorization?: string, origin?: string) => {
    const req = request(app.getHttpServer()).get('/api/v1/me');
    if (authorization !== undefined) req.set('Authorization', authorization);
    if (origin !== undefined) req.set('Origin', origin);
    return req;
  };
  /** Vary: Origin is cache hygiene the CORS middleware adds to any request from an active app origin; it says nothing about the token. */
  const fingerprint = (response: request.Response) => {
    const { date: _date, vary: _vary, ...headers } = response.headers;
    return { status: response.status, body: response.body, text: response.text, headers };
  };
  const tokenFor = async (target: App, accountId: string): Promise<string> => {
    const issuer = app.get<AccessTokenIssuer>(ACCESS_TOKEN_ISSUER);
    return `Bearer ${(await issuer.issue({ accountId, clientId: target.clientId })).token}`;
  };

  /** A token the issuer would never produce. It is signed with the service's own key unless `foreign` says otherwise. */
  const forge = async (options: { typ?: string | null; aud?: string | null; sub?: string; key?: 'own' | 'foreign' }) => {
    const { typ = 'at+jwt', aud = shop.clientId, sub = randomUUID(), key = 'own' } = options;
    const store =
      key === 'own' ? app.get<KeyStore>(KEY_STORE) : JwkSetKeyStore.fromJson(JSON.stringify(generateKeySet({ next: false })));
    const signing = store.activeSigningKey();
    const now = Math.floor(clock.now().getTime() / 1000);
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: signing.kid, ...(typ === null ? {} : { typ }) })
      .setIssuer('http://localhost:3000')
      .setSubject(sub)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setJti(randomUUID());
    if (aud !== null) jwt.setAudience(aud);
    return `Bearer ${await jwt.sign(signing.privateKey)}`;
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
  const addUser = async (target: App, email: string, confirmed = true): Promise<User> => {
    const now = new Date('2026-03-03T10:00:00.123Z');
    const registered = User.register({ id: randomUUID(), appId: target.id, email, passwordHash: '$2b$12$never-leaves-the-service', now });
    const user = confirmed ? registered.confirm(now) : registered;
    await new TypeOrmUserRepository(app.get(DataSource)).add(user);
    return user;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    clock = new FixedClock(new Date());
    app = await createTestApp({ databaseUrl: db.url, clock, passwordHasher: new LowCostPasswordHasher() });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    [shop, blog, parked] = [
      await registerApp('Shop', SHOP_ORIGIN),
      await registerApp('Blog', BLOG_ORIGIN),
      await registerApp('Parked', 'https://parked.example', 'inactive'),
    ];
  });

  describe('success', () => {
    it('returns exactly id, email, email_verified and created_at of the token account, with no-store headers', async () => {
      const user = await addUser(shop, 'ana@example.com');
      await addUser(shop, 'bea@example.com');

      const response = await me(await tokenFor(shop, user.id));

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: user.id,
        email: 'ana@example.com',
        email_verified: true,
        created_at: '2026-03-03T10:00:00.123Z',
      });
      expect(Object.keys(response.body).sort()).toEqual(['created_at', 'email', 'email_verified', 'id']);
      expect(response.text).not.toMatch(/never-leaves|password|hash|updated_at|app_id/i);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['pragma']).toBe('no-cache');
    });

    it('reports email_verified false for an unconfirmed account, and id equals the sub of the token', async () => {
      const user = await addUser(shop, 'pending@example.com', false);

      const response = await me(await tokenFor(shop, user.id));

      expect(response.body.email_verified).toBe(false);
      expect(response.body.id).toBe(user.id);
    });

    it('serves a server-side call with no Origin, and grants no allow header to it', async () => {
      const user = await addUser(blog, 'ana@example.com');

      const response = await me(await tokenFor(blog, user.id));

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('the generic 401', () => {
    it('is byte-identical (status, body, headers) for every cause and carries WWW-Authenticate: Bearer', async () => {
      const user = await addUser(shop, 'ana@example.com');
      const other = await addUser(blog, 'ana@example.com');
      const valid = await tokenFor(shop, user.id);
      const expiring = await tokenFor(shop, user.id);
      const responses = [
        await me(),
        await me('Bearer'),
        await me('Basic abc'),
        await me('Bearer not-a-jwt'),
        await me(await forge({ key: 'foreign', sub: user.id })),
        await me(await forge({ typ: 'JWT', sub: user.id })),
        await me(await forge({ typ: null, sub: user.id })),
        await me(await forge({ aud: null, sub: user.id })),
        await me(await forge({ aud: 'app_missing', sub: user.id })),
        await me(await forge({ aud: parked.clientId, sub: user.id })),
        await me(await forge({ sub: randomUUID() })), // an account that does not exist
        await me(await forge({ sub: other.id })), // an account of another app
        await me(valid, BLOG_ORIGIN), // origin of another app
        await me(valid, 'https://evil.example'),
      ];
      clock.advanceMs(3600 * 1000 + 10_000);
      responses.push(await me(expiring)); // expired

      const prints = responses.map(fingerprint);

      expect(prints[0]!.status).toBe(401);
      expect(prints[0]!.body).toEqual(INVALID_TOKEN_BODY);
      expect(prints[0]!.headers['www-authenticate']).toBe('Bearer');
      expect(prints[0]!.headers['cache-control']).toBe('no-store');
      for (const print of prints) expect(print).toEqual(prints[0]);
      for (const response of responses) expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('CORS bound to the token aud', () => {
    it("lets the browser read a 200 from the aud app's own origin, without credentials", async () => {
      const user = await addUser(shop, 'ana@example.com');

      const response = await me(await tokenFor(shop, user.id), SHOP_ORIGIN);

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(response.headers['vary']).toMatch(/Origin/);
    });

    it("gives app B's origin nothing for app A's token, and each app its own origin", async () => {
      const ana = await addUser(shop, 'ana@example.com');
      const bea = await addUser(blog, 'bea@example.com');

      const crossed = await me(await tokenFor(shop, ana.id), BLOG_ORIGIN);
      const own = await me(await tokenFor(blog, bea.id), BLOG_ORIGIN);

      expect(crossed.status).toBe(401);
      expect(crossed.headers['access-control-allow-origin']).toBeUndefined();
      expect(own.status).toBe(200);
      expect(own.headers['access-control-allow-origin']).toBe(BLOG_ORIGIN);
    });

    it('answers the preflight for an active app origin with the fixed header set', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/v1/me')
        .set('Origin', SHOP_ORIGIN)
        .set('Access-Control-Request-Method', 'GET')
        .set('Access-Control-Request-Headers', 'authorization');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    });
  });

  it('has no limiter: many calls stay 200 and the abuse guard is never called', async () => {
    const user = await addUser(shop, 'ana@example.com');
    const token = await tokenFor(shop, user.id);
    const guard = app.get(AbuseGuard, { strict: false });
    const methods = ['checkIp', 'checkClientIp', 'checkLoginIp', 'checkEmailAccount', 'beginLoginAttempt', 'recordLoginSuccess'] as const;
    const spies = methods.map((method) => jest.spyOn(guard, method));

    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await me(token)).status);

    expect(new Set(statuses)).toEqual(new Set([200]));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    spies.forEach((spy) => spy.mockRestore());
  });
});
