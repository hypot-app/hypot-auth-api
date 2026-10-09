import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import type { App } from '../../src/app-registry/domain/app';
import { buildOpenApiDocument } from '../../src/openapi/openapi-document';
import { createTestApp } from '../support/create-test-app';
import { addTestUser, registerTestApp } from '../support/e2e-fixtures';
import { listRoutes } from '../support/list-routes';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { expectDocumented } from '../support/openapi-conformance';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const document = buildOpenApiDocument({ version });
const ORIGIN = 'https://shop.example';
const PASSWORD = 'correct horse';
const NEW_PASSWORD = 'staple battery horse';
/** Every POST route of the API with the smallest body that passes the content-type check. */
const POST_PATHS = Object.entries(document.paths)
  .filter(([, methods]) => 'post' in methods)
  .map(([path]) => path);

describe('OpenAPI document against the running app (e2e, 19.2)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({ email_ip: { limit: 3, windowSeconds: 3600 } }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    shop = await registerTestApp(app, 'Shop', ORIGIN);
  });

  it('describes exactly the registered routes: same methods, same paths', () => {
    const described = Object.entries(document.paths)
      .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
      .sort();
    const registered = listRoutes(app).map(({ method, path }) => `${method} ${path}`).sort();

    expect(described).toEqual(registered);
  });

  it('describes the root routes as they answer', async () => {
    expectDocumented(document, await request(server()).get('/').expect(200), 'get', '/');
    expectDocumented(document, await request(server()).get('/health').expect(200), 'get', '/health');
    const jwks = await request(server()).get('/.well-known/jwks.json').expect(200);
    expectDocumented(document, jwks, 'get', '/.well-known/jwks.json');
    expect(jwks.headers['cache-control']).toBe('public, max-age=300');
  });

  it.each(POST_PATHS)('POST %s answers 415 as documented when the body is not JSON', async (path) => {
    const noType = await request(server()).post(path).send();
    const form = await request(server()).post(path).type('form').send({ a: 'b' });

    for (const response of [noType, form]) {
      expect(response.status).toBe(415);
      expectDocumented(document, response, 'post', path);
    }
  });

  it.each(POST_PATHS.filter((path) => path !== '/api/v1/password/change'))(
    'POST %s answers an empty object with the documented invalid_request 400',
    async (path) => {
      const response = await request(server()).post(path).send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
      expectDocumented(document, response, 'post', path);
    },
  );

  it('answers a missing bearer on /me and /password/change with the documented 401 and WWW-Authenticate', async () => {
    const me = await request(server()).get('/api/v1/me');
    const change = await request(server()).post('/api/v1/password/change').send({ current_password: 'a', new_password: 'b' });

    for (const [response, method, path] of [[me, 'get', '/api/v1/me'], [change, 'post', '/api/v1/password/change']] as const) {
      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expectDocumented(document, response, method, path);
    }
  });

  it.each(['/api/v1/accounts/signup', '/api/v1/accounts/resend-confirmation', '/api/v1/password/forgot'])(
    'POST %s answers an invalid address with the documented invalid_email 400',
    async (path) => {
      const response = await request(server()).post(path).send({ client_id: shop.clientId, email: 'not-an-email', password: PASSWORD });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_email');
      expectDocumented(document, response, 'post', path);
    },
  );

  it('answers an unknown client with the documented invalid_client 400 on the email routes and on refresh', async () => {
    const unknown = `app_${'0'.repeat(32)}`;
    const cases: [string, Record<string, unknown>][] = [
      ['/api/v1/accounts/signup', { email: 'a@example.com', password: PASSWORD }],
      ['/api/v1/accounts/resend-confirmation', { email: 'a@example.com' }],
      ['/api/v1/password/forgot', { email: 'a@example.com' }],
      ['/api/v1/auth/refresh', { refresh_token: 'x' }],
    ];
    for (const [path, body] of cases) {
      const response = await request(server()).post(path).send({ client_id: unknown, ...body });
      expect([path, response.status, response.body.error]).toEqual([path, 400, 'invalid_client']);
      expectDocumented(document, response, 'post', path);
    }
  });

  it('answers login with the documented generic 401 and refresh with the documented invalid_grant', async () => {
    await addTestUser(app, { appId: shop.id, email: 'ana@example.com', passwordHash: await new LowCostPasswordHasher().hash(PASSWORD) });

    const login = await request(server()).post('/api/v1/auth/login').send({ client_id: shop.clientId, email: 'ana@example.com', password: 'wrong' });
    const refresh = await request(server()).post('/api/v1/auth/refresh').send({ client_id: shop.clientId, refresh_token: 'nope' });

    expect(login.status).toBe(401);
    expectDocumented(document, login, 'post', '/api/v1/auth/login');
    expect(refresh.status).toBe(401);
    expectDocumented(document, refresh, 'post', '/api/v1/auth/refresh');
  });

  it('answers the limiter with the documented 429 and a Retry-After that is an integer', async () => {
    const body = { client_id: shop.clientId, email: 'ana@example.com', password: PASSWORD };
    for (let attempt = 0; attempt < 3; attempt++) await request(server()).post('/api/v1/accounts/signup').send(body).expect(202);

    const limited = await request(server()).post('/api/v1/accounts/signup').send(body);

    expect(limited.status).toBe(429);
    expectDocumented(document, limited, 'post', '/api/v1/accounts/signup');
  });

  it('answers the documented 503 on every endpoint that consults the limiter, and none on logout', async () => {
    await addTestUser(app, { appId: shop.id, email: 'ana@example.com', passwordHash: await new LowCostPasswordHasher().hash(PASSWORD) });
    const session = await request(server()).post('/api/v1/auth/login').send({ client_id: shop.clientId, email: 'ana@example.com', password: PASSWORD }).expect(200);
    const bearer = session.body.access_token as string;
    const client = shop.clientId;
    const cases: [string, Record<string, unknown>][] = [
      ['/api/v1/accounts/signup', { client_id: client, email: 'new@example.com', password: PASSWORD }],
      ['/api/v1/accounts/resend-confirmation', { client_id: client, email: 'ana@example.com' }],
      ['/api/v1/accounts/confirm', { token: 'x' }],
      ['/api/v1/auth/login', { client_id: client, email: 'ana@example.com', password: PASSWORD }],
      ['/api/v1/auth/refresh', { client_id: client, refresh_token: session.body.refresh_token }],
      ['/api/v1/password/forgot', { client_id: client, email: 'ana@example.com' }],
      ['/api/v1/password/reset', { token: 'x', new_password: NEW_PASSWORD }],
      ['/api/v1/password/change', { current_password: PASSWORD, new_password: NEW_PASSWORD }],
    ];

    await db.dataSource.query('ALTER TABLE abuse_counters RENAME TO abuse_counters_off');
    try {
      for (const [path, body] of cases) {
        const req = request(server()).post(path);
        if (path.endsWith('/change')) req.set('Authorization', `Bearer ${bearer}`);
        const response = await req.send(body);
        expect([path, response.status]).toEqual([path, 503]);
        expectDocumented(document, response, 'post', path);
      }
      const logout = await request(server()).post('/api/v1/auth/logout').send({ client_id: client, refresh_token: 'x' });
      expect(logout.status).toBe(204);
      expect(Object.keys(document.paths['/api/v1/auth/logout']!.post!.responses as object)).not.toContain('503');
    } finally {
      await db.dataSource.query('ALTER TABLE abuse_counters_off RENAME TO abuse_counters');
    }
  });
});
