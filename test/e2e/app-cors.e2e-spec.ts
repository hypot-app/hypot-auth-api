import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CorsGrant } from '../../src/app-registry/http/cors-grant';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

// Probes standing in for the real routes that arrive in later units.
@Controller()
class ProbeController {
  // Stands in for an endpoint whose binding passed: it grants CORS.
  @Post('auth/login')
  login(@CorsGrant() grantCors: () => void): { ok: true } {
    grantCors();
    return { ok: true };
  }

  // Never grants CORS: stands in for an endpoint whose author forgot (fail-closed).
  @Get('me')
  me(): { ok: true } {
    return { ok: true };
  }

  @Post('auth/logout')
  logout(): never {
    throw new Error('unexpected failure');
  }
}

describe('CORS origin allowlist (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;

  const server = () => app.getHttpServer();

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url, controllers: [ProbeController] });
    const register = app.get(RegisterAppUseCase);
    const create = async (name: string, origins: string[]): Promise<string> => {
      const result = await register.execute({
        name,
        clientType: 'public',
        redirectUris: [],
        allowedOrigins: origins,
        emailConfirmationUrl: `${origins[0]}/confirm`,
        passwordResetUrl: `${origins[0]}/reset`,
        isProduction: false,
      });
      if (!result.ok) throw result.error;
      return result.value.app.clientId;
    };
    await create('A', ['https://a.example']);
    await create('B', ['https://b.example', 'http://localhost:5173']);
    const off = await create('Off', ['https://off.example']);
    await db.dataSource.query(`UPDATE apps SET status = 'inactive' WHERE client_id = $1`, [off]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it.each(['https://a.example', 'https://b.example', 'http://localhost:5173'])(
    'echoes %s, registered by some active app, with no client_id anywhere',
    async (origin) => {
      const response = await request(server()).post('/api/v1/auth/login').set('Origin', origin).expect(201);

      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['vary']).toMatch(/Origin/);
    },
  );

  it('grants nothing to an endpoint that never calls the grant (fail-closed)', async () => {
    const response = await request(server())
      .get('/api/v1/me')
      .set('Authorization', 'Bearer x')
      .set('Origin', 'https://a.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['vary']).toMatch(/Origin/);
  });

  it('grants nothing to an unexpected 500', async () => {
    const response = await request(server()).post('/api/v1/auth/logout').set('Origin', 'https://a.example').expect(500);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  const API_ROUTES = [
    'auth/login',
    'auth/refresh',
    'auth/logout',
    'accounts/signup',
    'accounts/confirm',
    'accounts/resend-confirmation',
    'password/forgot',
    'password/reset',
    'password/change',
    'me',
  ];

  it.each(API_ROUTES)('answers a preflight for %s with exactly the specified headers', async (route) => {
    const response = await request(server())
      .options(`/api/v1/${route}`)
      .set('Origin', 'https://a.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-custom');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
    expect(response.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('Content-Type, Authorization');
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(response.headers['vary']).toBe('Origin');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('no longer covers the legacy OAuth routes', async () => {
    const response = await request(server())
      .options('/api/v1/oauth/token')
      .set('Origin', 'https://a.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns no CORS headers for an unknown origin', async () => {
    const response = await request(server()).post('/api/v1/auth/login').set('Origin', 'https://other.example').expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns no CORS headers on a preflight from an unknown origin', async () => {
    const response = await request(server())
      .options('/api/v1/me')
      .set('Origin', 'https://other.example')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });

  it('returns no CORS headers for the origin of an inactive app', async () => {
    const response = await request(server()).post('/api/v1/auth/login').set('Origin', 'https://off.example').expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each(['https://a.example/', 'HTTPS://A.EXAMPLE', 'https://sub.a.example', 'null'])(
    'matches origins exactly: %s is not allowed',
    async (origin) => {
      const response = await request(server()).post('/api/v1/auth/login').set('Origin', origin).expect(201);

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('adds no CORS headers when the request has no Origin', async () => {
    const response = await request(server()).post('/api/v1/auth/login').expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard origin or credentials', async () => {
    const response = await request(server()).post('/api/v1/auth/login').set('Origin', 'https://a.example');

    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not apply to routes outside the API CORS surface', async () => {
    const response = await request(server()).get('/health').set('Origin', 'https://a.example').expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
