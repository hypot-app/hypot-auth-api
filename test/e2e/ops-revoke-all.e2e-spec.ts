import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { runCli } from '../support/cli-harness';
import { createTestApp } from '../support/create-test-app';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const PASSWORD = 'correct horse battery';

describe('ops:revoke-all against a running API (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;

  const post = (path: string, body: object) => request(app.getHttpServer()).post(`/api/v1/auth/${path}`).send(body);
  const loginAs = async (email: string): Promise<string> => {
    const hash = await new LowCostPasswordHasher().hash(PASSWORD);
    const user = User.register({ id: randomUUID(), appId: shop.id, email, passwordHash: hash, now: new Date() }).confirm(new Date());
    await new TypeOrmUserRepository(app.get(DataSource)).add(user);
    const response = await post('login', { client_id: shop.clientId, email, password: PASSWORD }).expect(200);
    return response.body.refresh_token;
  };
  const refresh = (token: string) => post('refresh', { client_id: shop.clientId, refresh_token: token });

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url, passwordHasher: new LowCostPasswordHasher() });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    const now = new Date();
    shop = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: ['https://shop.example'],
      emailFrom: null,
      emailConfirmationUrl: null,
      passwordResetUrl: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(shop);
  });

  it('makes every refresh fail afterward, with invalid_grant, for every user', async () => {
    const [ana, bob] = [await loginAs('ana@example.com'), await loginAs('bob@example.com')];

    const run = await runCli(['ops:revoke-all', '--yes'], { databaseUrl: db.url });

    expect(run.errors).toEqual([]);
    expect(run.out).toEqual(['revoked sessions: 2']);
    for (const token of [ana, bob]) {
      const response = await refresh(token);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ error: 'invalid_grant' });
    }
    expect((await db.dataSource.query(`SELECT DISTINCT revoked_reason FROM auth_sessions`)).map((row: { revoked_reason: string }) => row.revoked_reason)).toEqual([
      'ops_revoke_all',
    ]);
  });

  it('leaves every session working when --yes is missing', async () => {
    const ana = await loginAs('ana@example.com');

    const run = await runCli(['ops:revoke-all'], { databaseUrl: db.url });

    expect(run.errors).toHaveLength(1);
    expect((await refresh(ana)).status).toBe(200);
  });

  it('lets a user log in again after the revocation', async () => {
    await loginAs('ana@example.com');
    await runCli(['ops:revoke-all', '--yes'], { databaseUrl: db.url });

    const response = await post('login', { client_id: shop.clientId, email: 'ana@example.com', password: PASSWORD });

    expect(response.status).toBe(200);
    expect((await refresh(response.body.refresh_token)).status).toBe(200);
  });
});
