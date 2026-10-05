import { randomUUID } from 'node:crypto';
import { AppSchema, type AppRow } from '../../src/app-registry/infrastructure/persistence/app.schema';
import {
  OneTimeTokenSchema,
  type OneTimeTokenRow,
} from '../../src/user-accounts/infrastructure/persistence/one-time-token.schema';
import { UserSchema, type UserRow } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const appRow = (): AppRow => ({
  id: randomUUID(),
  client_id: `app_${randomUUID().replaceAll('-', '')}`,
  name: 'Shop',
  client_type: 'public',
  client_secret_hash: null,
  redirect_uris: [],
  allowed_origins: [],
  email_from: null,
  post_reset_redirect_uri: null,
  status: 'active',
  created_at: NOW,
  updated_at: NOW,
});

const userRow = (appId: string, overrides: Partial<UserRow> = {}): UserRow => ({
  id: randomUUID(),
  app_id: appId,
  email: 'ana@example.com',
  password_hash: '$2b$12$hash',
  email_verified_at: null,
  password_changed_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const tokenRow = (userId: string, overrides: Partial<OneTimeTokenRow> = {}): OneTimeTokenRow => ({
  id: randomUUID(),
  user_id: userId,
  purpose: 'email_verification',
  token_hash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
  expires_at: NOW,
  consumed_at: null,
  ...overrides,
});

describe('users and one_time_tokens tables (integration)', () => {
  let db: TestDatabase;
  let appA: string;
  let appB: string;
  const users = () => db.dataSource.getRepository<UserRow>(UserSchema);
  const tokens = () => db.dataSource.getRepository<OneTimeTokenRow>(OneTimeTokenSchema);
  const exists = async (table: string): Promise<boolean> => {
    const rows: { exists: boolean }[] = await db.dataSource.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
      `public.${table}`,
    ]);
    return rows[0].exists;
  };

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, OneTimeTokenSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    const [a, b] = [appRow(), appRow()];
    await db.dataSource.getRepository<AppRow>(AppSchema).save([a, b]);
    appA = a.id;
    appB = b.id;
  });

  describe('users', () => {
    it('allows the same email in two apps as independent accounts', async () => {
      await users().save(userRow(appA, { password_hash: 'hash-a' }));
      await users().save(userRow(appB, { password_hash: 'hash-b' }));

      expect(await users().countBy({ email: 'ana@example.com' })).toBe(2);
    });

    it('rejects the same email twice in one app, ignoring case', async () => {
      await users().save(userRow(appA, { email: 'ana@example.com' }));
      await expect(users().save(userRow(appA, { email: 'ANA@Example.com' }))).rejects.toThrow(
        /duplicate key value violates unique constraint "UQ_users_app_id_email"/,
      );
    });

    it('rejects an account for a nonexistent app', async () => {
      await expect(users().save(userRow(randomUUID()))).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('one_time_tokens', () => {
    it('rejects a duplicate token hash', async () => {
      const user = userRow(appA);
      await users().save(user);
      const hash = Buffer.alloc(32, 5);
      await tokens().save(tokenRow(user.id, { token_hash: hash }));
      await expect(tokens().save(tokenRow(user.id, { token_hash: hash }))).rejects.toThrow(
        /duplicate key value violates unique constraint/,
      );
    });

    it('rejects an unknown purpose', async () => {
      const user = userRow(appA);
      await users().save(user);
      await expect(
        tokens().save(tokenRow(user.id, { purpose: 'weird' as OneTimeTokenRow['purpose'] })),
      ).rejects.toThrow(/invalid input value for enum/);
    });
  });

  describe('migrations', () => {
    it('CreateUsers and CreateOneTimeTokens are reversible: up -> down -> up', async () => {
      expect([await exists('users'), await exists('one_time_tokens')]).toEqual([true, true]);

      await db.revertThrough('CreateUsers');
      expect([await exists('users'), await exists('one_time_tokens')]).toEqual([false, false]);
      const types: { count: string }[] = await db.dataSource.query(
        `SELECT count(*) FROM pg_type WHERE typname = 'one_time_tokens_purpose_enum'`,
      );
      expect(Number(types[0].count)).toBe(0);
      expect(await exists('apps')).toBe(true);

      await db.dataSource.runMigrations();
      expect([await exists('users'), await exists('one_time_tokens')]).toEqual([true, true]);
    });
  });
});
