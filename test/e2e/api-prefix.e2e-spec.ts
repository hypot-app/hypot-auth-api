import { Controller, Get, UnauthorizedException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

// Probes stand in for business routes that later units add (GET /me, GET /.well-known/jwks.json).
@Controller('me')
class MeProbeController {
  @Get()
  me(): never {
    throw new UnauthorizedException();
  }
}

@Controller('.well-known')
class JwksProbeController {
  @Get('jwks.json')
  jwks(): { keys: never[] } {
    return { keys: [] };
  }
}

describe('API prefix (e2e, ADR 28)', () => {
  let db: TestDatabase;
  let app: INestApplication;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      controllers: [MeProbeController, JwksProbeController],
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it('serves business routes under /api/v1', async () => {
    await request(app.getHttpServer()).get('/api/v1/me').expect(401);
  });

  it('does not route business paths at the root', async () => {
    await request(app.getHttpServer()).get('/me').expect(404);
  });

  it('keeps GET / at the root and not under the prefix', async () => {
    await request(app.getHttpServer()).get('/').expect(200);
    await request(app.getHttpServer()).get('/api/v1/').expect(404);
  });

  it('keeps GET /health at the root and not under the prefix', async () => {
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/health').expect(404);
  });

  it('keeps /.well-known/jwks.json at the root and not under the prefix', async () => {
    const response = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);
    expect(response.body).toEqual({ keys: [] });
    await request(app.getHttpServer()).get('/api/v1/.well-known/jwks.json').expect(404);
  });
});
