import type { INestApplication } from '@nestjs/common';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { hashToken } from '../../src/shared-kernel/token-generator';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('AppRegistryModule wiring (integration)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let register: RegisterAppUseCase;
  let resolve: ResolveClientUseCase;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url });
    register = app.get(RegisterAppUseCase);
    resolve = app.get(ResolveClientUseCase);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('registers a confidential app end to end: the database holds only the secret hash', async () => {
    const result = await register.execute({
      name: 'Shop',
      clientType: 'confidential',
      redirectUris: ['https://a.example/cb'],
      allowedOrigins: ['https://a.example'],
      postResetRedirectUri: 'https://a.example/login',
      isProduction: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secret = result.value.clientSecret as string;

    const rows: { client_secret_hash: Buffer; post_reset_redirect_uri: string }[] = await db.dataSource.query(
      'SELECT client_secret_hash, post_reset_redirect_uri FROM apps WHERE client_id = $1',
      [result.value.app.clientId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].client_secret_hash.equals(hashToken(secret))).toBe(true);
    expect(rows[0].post_reset_redirect_uri).toBe('https://a.example/login');

    const dump = JSON.stringify(await db.dataSource.query('SELECT * FROM apps'));
    expect(dump).not.toContain(secret);
  });

  it('persists nothing when the post-reset URI is invalid', async () => {
    const result = await register.execute({
      name: 'Shop',
      clientType: 'public',
      redirectUris: [],
      allowedOrigins: [],
      postResetRedirectUri: 'http://a.example/login',
      isProduction: false,
    });
    expect(result.ok).toBe(false);
    expect(await db.dataSource.query('SELECT 1 FROM apps')).toHaveLength(0);
  });

  it('resolves a registered app and rejects unknown and mismatched requests', async () => {
    const registered = await register.execute({
      name: 'Shop',
      clientType: 'public',
      redirectUris: ['https://a.example/cb'],
      allowedOrigins: [],
      isProduction: false,
    });
    if (!registered.ok) throw registered.error;
    const clientId = registered.value.app.clientId;

    expect((await resolve.execute({ clientId, redirectUri: 'https://a.example/cb' })).ok).toBe(true);
    const mismatch = await resolve.execute({ clientId, redirectUri: 'https://evil.example/cb' });
    expect(!mismatch.ok && mismatch.error.code).toBe('invalid_redirect_uri');
    const unknown = await resolve.execute({ clientId: 'zzz' });
    expect(!unknown.ok && unknown.error.code).toBe('invalid_client');

    await db.dataSource.query(`UPDATE apps SET status = 'inactive' WHERE client_id = $1`, [clientId]);
    const inactive = await resolve.execute({ clientId });
    expect(!inactive.ok && inactive.error.code).toBe('invalid_client');
  });
});
