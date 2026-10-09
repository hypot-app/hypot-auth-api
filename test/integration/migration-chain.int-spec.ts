import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'src', 'platform', 'persistence', 'migrations');
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((file) => /^\d+-.+\.ts$/.test(file)).sort();

describe('full migration chain (integration, 19.7)', () => {
  let db: TestDatabase;
  const query = <T>(sql: string): Promise<T[]> => db.dataSource.query(sql);
  const tables = async (): Promise<string[]> =>
    (await query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations' ORDER BY 1`)).map(
      (row) => row.tablename,
    );
  const enums = async (): Promise<string[]> =>
    (await query<{ typname: string }>(`SELECT DISTINCT t.typname FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY 1`)).map((row) => row.typname);
  const indexes = async (): Promise<string[]> =>
    (await query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename <> 'migrations' ORDER BY 1`)).map(
      (row) => row.indexname,
    );
  const applied = async (): Promise<string[]> => (await query<{ name: string }>(`SELECT name FROM migrations ORDER BY id`)).map((row) => row.name);

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it('has one migration per file, applied in timestamp order', async () => {
    expect(migrationFiles.length).toBeGreaterThanOrEqual(8);
    expect(await applied()).toEqual(migrationFiles.map((file) => file.replace(/^(\d+)-(.+)\.ts$/, '$2$1')));
  });

  it('reverts every migration to an empty schema, then runs them all again to the same schema', async () => {
    const before = { tables: await tables(), enums: await enums(), indexes: await indexes() };
    expect(before.tables).toEqual(
      expect.arrayContaining(['abuse_counters', 'apps', 'auth_sessions', 'email_outbox', 'one_time_tokens', 'refresh_tokens', 'users']),
    );

    for (let i = 0; i < migrationFiles.length; i++) await db.dataSource.undoLastMigration();

    expect(await applied()).toEqual([]);
    expect(await tables()).toEqual([]);
    expect(await enums()).toEqual([]);
    expect(await indexes()).toEqual([]);

    await db.dataSource.runMigrations();

    expect(await applied()).toHaveLength(migrationFiles.length);
    expect({ tables: await tables(), enums: await enums(), indexes: await indexes() }).toEqual(before);
  });
});
