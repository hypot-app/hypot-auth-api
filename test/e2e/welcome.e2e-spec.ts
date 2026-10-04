import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('GET / (e2e)', () => {
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

  it('returns the welcome message', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);
    expect(response.body).toEqual({ message: 'Welcome to the API' });
  });
});
