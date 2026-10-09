import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/create-test-app';
import { listRoutes } from '../support/list-routes';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('route table (e2e, 19.1)', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it('registers exactly 13 routes: 3 at the root and 10 under /api/v1', () => {
    const routes = listRoutes(app).map(({ method, path }) => `${method} ${path}`);

    expect(routes).toEqual(
      [
        'GET /',
        'GET /.well-known/jwks.json',
        'GET /health',
        'GET /api/v1/me',
        'POST /api/v1/accounts/confirm',
        'POST /api/v1/accounts/resend-confirmation',
        'POST /api/v1/accounts/signup',
        'POST /api/v1/auth/login',
        'POST /api/v1/auth/logout',
        'POST /api/v1/auth/refresh',
        'POST /api/v1/password/change',
        'POST /api/v1/password/forgot',
        'POST /api/v1/password/reset',
      ].sort((a, b) => a.split(' ')[1]!.localeCompare(b.split(' ')[1]!)),
    );
    expect(routes).toHaveLength(13);
    expect(routes.filter((route) => !route.includes(' /api/v1/'))).toHaveLength(3);
  });

  it('has no OAuth route and no page route', () => {
    const paths = listRoutes(app).map((route) => route.path);

    expect(paths.filter((path) => /oauth|authorize|\/token\b/.test(path))).toEqual([]);
    expect(paths.filter((path) => /login-page|consent|\.html$|\/static|\/assets|\/pages?\b/.test(path))).toEqual([]);
    // The only routes that answer with a body for a browser are JSON; the welcome route is a JSON document too.
    expect(paths).not.toContain('/api/v1/oauth/authorize');
  });

  it('has no GET under /accounts/confirm or /password/*', async () => {
    const routes = listRoutes(app);

    const sensitive = routes.filter((route) => /^\/api\/v1\/(accounts\/confirm|password)/.test(route.path));
    expect(sensitive.length).toBeGreaterThanOrEqual(4);
    expect(sensitive.filter((route) => route.method !== 'POST')).toEqual([]);
    for (const path of ['/api/v1/accounts/confirm', '/api/v1/password/forgot', '/api/v1/password/reset', '/api/v1/password/change']) {
      await request(app.getHttpServer()).get(path).expect(404);
    }
  });

  it('answers 404 under /api/v1/oauth/*, whatever the method', async () => {
    for (const path of ['/api/v1/oauth/authorize', '/api/v1/oauth/token']) {
      await request(app.getHttpServer()).get(path).expect(404);
      await request(app.getHttpServer()).post(path).set('Content-Type', 'application/json').send({}).expect(404);
    }
  });
});
