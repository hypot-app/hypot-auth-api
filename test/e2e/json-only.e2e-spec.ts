import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { createTestApp } from '../support/create-test-app';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BODY = { error: 'unsupported_media_type', message: 'Request body must be JSON.' };

describe('JSON-only POST bodies (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let hasher: FakePasswordHasher;
  let shop: App;

  const server = () => app.getHttpServer();
  const counters = async (): Promise<number> =>
    Number((await db.dataSource.query('SELECT count(*) AS n FROM abuse_counters'))[0].n);
  const users = async (): Promise<number> => Number((await db.dataSource.query('SELECT count(*) AS n FROM users'))[0].n);

  beforeAll(async () => {
    db = await startTestDatabase();
    hasher = new FakePasswordHasher();
    app = await createTestApp({ databaseUrl: db.url, passwordHasher: hasher });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    hasher.hashCalls = 0;
    const now = new Date();
    shop = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [SHOP_ORIGIN],
      emailFrom: null,
      emailConfirmationUrl: `${SHOP_ORIGIN}/confirm`,
      passwordResetUrl: `${SHOP_ORIGIN}/reset`,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(shop);
  });

  const routes = ['/api/v1/accounts/signup', '/api/v1/accounts/confirm', '/api/v1/auth/login'];
  const fields = () => ({ client_id: shop.clientId, email: 'ana@example.com', password: 'correct horse', token: 'x' });
  const asForm = (path: string) => request(server()).post(path).set('Origin', SHOP_ORIGIN).type('form').send(fields());
  const asMultipart = (path: string) => {
    const r = request(server()).post(path).set('Origin', SHOP_ORIGIN);
    for (const [key, value] of Object.entries(fields())) r.field(key, value);
    return r;
  };
  const asText = (path: string) =>
    request(server())
      .post(path)
      .set('Origin', SHOP_ORIGIN)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(fields()));

  describe.each([
    ['form-urlencoded', asForm],
    ['multipart/form-data', asMultipart],
    ['text/plain', asText],
  ])('%s', (_name, send) => {
    it.each(routes)('answers 415 to POST %s without touching the abuse guard or the database', async (path) => {
      for (let i = 0; i < 5; i += 1) {
        const response = await send(path);

        expect(response.status).toBe(415);
        expect(response.body).toEqual(BODY);
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
      expect(await counters()).toBe(0);
      expect(await users()).toBe(0);
      expect(hasher.hashCalls).toBe(0);
    });
  });

  it('answers 415 to a POST with no Content-Type and no body', async () => {
    const response = await request(server()).post('/api/v1/auth/logout');

    expect(response.status).toBe(415);
    expect(response.body).toEqual(BODY);
  });

  it('still serves application/json with a charset parameter', async () => {
    const response = await request(server())
      .post('/api/v1/accounts/signup')
      .set('Content-Type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ client_id: shop.clientId, email: 'ana@example.com', password: 'correct horse' }));

    expect(response.status).toBe(202);
    expect(await counters()).toBeGreaterThan(0);
  });

  it('leaves preflights and GET routes alone', async () => {
    const preflight = await request(server())
      .options('/api/v1/auth/login')
      .set('Origin', SHOP_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    const health = await request(server()).get('/health');

    expect(preflight.status).toBe(204);
    expect(health.status).toBe(200);
  });
});
