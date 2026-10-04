import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('GET /health (e2e)', () => {
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

  it('reports ok when the database answers the ping', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('answers 503 without leaking details when the database is unreachable', async () => {
    await app.get(DataSource).destroy();

    const response = await request(app.getHttpServer()).get('/health').expect(503);
    expect(response.body).toEqual({ status: 'error', db: 'down' });
  });
});
