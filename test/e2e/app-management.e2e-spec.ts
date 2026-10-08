import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('app management is CLI-only (e2e)', () => {
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

  it.each([
    ['POST', '/api/v1/apps'],
    ['GET', '/api/v1/apps'],
    ['GET', '/api/v1/apps/abc'],
    ['PUT', '/api/v1/apps/abc'],
    ['PATCH', '/api/v1/apps/abc'],
    ['DELETE', '/api/v1/apps/abc'],
    ['POST', '/api/v1/apps/abc/deactivate'],
    ['POST', '/apps'],
    ['DELETE', '/apps/abc'],
  ] as const)('%s %s answers 404', async (method, path) => {
    const server = app.getHttpServer();
    const call = { POST: request(server).post(path).send({}), GET: request(server).get(path), PUT: request(server).put(path), PATCH: request(server).patch(path), DELETE: request(server).delete(path) }[method];
    await call.expect(404);
  });
});
