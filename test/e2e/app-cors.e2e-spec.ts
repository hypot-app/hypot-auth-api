import { Controller, Get, Post, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

// Probes standing in for the real routes that arrive in later units.
@Controller()
class ProbeController {
  @Post('oauth/token')
  token(): { ok: true } {
    return { ok: true };
  }

  @Get('me')
  me(): { ok: true } {
    return { ok: true };
  }
}

describe('per-app CORS (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let clientA: string;
  let clientB: string;
  let clientOff: string;

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
        isProduction: false,
      });
      if (!result.ok) throw result.error;
      return result.value.app.clientId;
    };
    clientA = await create('A', ['https://a.example']);
    clientB = await create('B', ['https://b.example']);
    clientOff = await create('Off', ['https://off.example']);
    await db.dataSource.query(`UPDATE apps SET status = 'inactive' WHERE client_id = $1`, [clientOff]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it('echoes a registered origin when client_id is in the query string', async () => {
    const response = await request(server())
      .post(`/api/v1/oauth/token?client_id=${clientA}`)
      .set('Origin', 'https://a.example')
      .expect(201);

    expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
    expect(response.headers['vary']).toMatch(/Origin/);
  });

  it('reads client_id from a form-encoded body', async () => {
    const response = await request(server())
      .post('/api/v1/oauth/token')
      .type('form')
      .send({ client_id: clientA, grant_type: 'authorization_code' })
      .set('Origin', 'https://a.example')
      .expect(201);

    expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
  });

  it('answers a preflight for a registered origin with 204 and the allow headers', async () => {
    const response = await request(server())
      .options(`/api/v1/oauth/token?client_id=${clientA}`)
      .set('Origin', 'https://a.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
    expect(response.headers['access-control-allow-methods']).toMatch(/POST/);
    expect(response.headers['access-control-allow-headers']).toMatch(/content-type/i);
  });

  it('returns no allow header for an origin the app did not register', async () => {
    const response = await request(server())
      .post(`/api/v1/oauth/token?client_id=${clientA}`)
      .set('Origin', 'https://other.example')
      .expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not let one app use the origins of another', async () => {
    const response = await request(server())
      .post(`/api/v1/oauth/token?client_id=${clientB}`)
      .set('Origin', 'https://a.example')
      .expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns no allow header on a preflight from an unregistered origin', async () => {
    const response = await request(server())
      .options(`/api/v1/oauth/token?client_id=${clientA}`)
      .set('Origin', 'https://other.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
  });

  it.each([
    ['an unknown client_id', 'zzz'],
    ['no client_id', ''],
  ])('returns no allow header for %s', async (_label, clientId) => {
    const url = clientId ? `/api/v1/oauth/token?client_id=${clientId}` : '/api/v1/oauth/token';
    const response = await request(server()).post(url).set('Origin', 'https://a.example').expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns no allow header for an inactive app', async () => {
    const response = await request(server())
      .post(`/api/v1/oauth/token?client_id=${clientOff}`)
      .set('Origin', 'https://off.example')
      .expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds no CORS headers when the request has no Origin', async () => {
    const response = await request(server()).post(`/api/v1/oauth/token?client_id=${clientA}`).expect(201);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard origin', async () => {
    const response = await request(server())
      .post(`/api/v1/oauth/token?client_id=${clientA}`)
      .set('Origin', 'https://a.example');

    expect(response.headers['access-control-allow-origin']).not.toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('covers GET /api/v1/me too', async () => {
    const response = await request(server())
      .get(`/api/v1/me?client_id=${clientA}`)
      .set('Origin', 'https://a.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
  });

  it('does not apply to routes outside the API CORS surface', async () => {
    const response = await request(server())
      .get(`/health?client_id=${clientA}`)
      .set('Origin', 'https://a.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
