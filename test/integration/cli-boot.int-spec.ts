import { CommandFactory } from 'nest-commander';
import { CliModule } from '../../src/cli.module';
import { APP_CONFIG, type AppConfig } from '../../src/platform/config/app-config';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('operator CLI boot (W2: least privilege)', () => {
  let db: TestDatabase;
  const saved = { ...process.env };

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    process.env = saved;
    await db?.teardown();
  }, 60_000);

  it('boots the real CliModule with no signing key variable at all', async () => {
    delete process.env.AUTH_SIGNING_KEYS;
    delete process.env.AUTH_SIGNING_KEYS_FILE;
    Object.assign(process.env, {
      DATABASE_URL: db.url,
      AUTH_PUBLIC_BASE_URL: 'http://localhost:3000',
      SMTP_HOST: 'localhost',
      MAIL_FROM: 'no-reply@example.test',
    });

    const context = await CommandFactory.createWithoutRunning(CliModule, { logger: false, abortOnError: false });
    try {
      expect(context.get<AppConfig>(APP_CONFIG).databaseUrl).toBe(db.url);
    } finally {
      await context.close();
    }
  });
});
