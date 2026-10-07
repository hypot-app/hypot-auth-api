import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('abuse_counters table (integration, ADR 36)', () => {
  let db: TestDatabase;
  const query = <T>(sql: string): Promise<T[]> => db.dataSource.query(sql);

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it('is UNLOGGED, so per-request writes skip the WAL', async () => {
    const rows = await query<{ relpersistence: string }>(
      `SELECT relpersistence FROM pg_class WHERE relname = 'abuse_counters'`,
    );
    expect(rows).toEqual([{ relpersistence: 'u' }]);
  });

  it('has the primary key (scope, key) and an index on expires_at', async () => {
    const pk = await query<{ column_name: string }>(`
      SELECT a.attname AS column_name FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = 'abuse_counters'::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey::int2[], a.attnum)`);
    expect(pk.map((row) => row.column_name)).toEqual(['scope', 'key']);
    const indexes = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'abuse_counters' AND indexname <> 'PK_abuse_counters'`,
    );
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toContain('(expires_at)');
  });

  it('is reversible: up -> down -> up', async () => {
    const exists = async (): Promise<boolean> =>
      (await query<{ exists: boolean }>(`SELECT to_regclass('public.abuse_counters') IS NOT NULL AS exists`))[0]!.exists;
    expect(await exists()).toBe(true);

    await db.revertThrough('CreateAbuseCounters');
    expect(await exists()).toBe(false);

    await db.dataSource.runMigrations();
    expect(await exists()).toBe(true);
    // Persistence survives the round trip.
    const rows = await query<{ relpersistence: string }>(
      `SELECT relpersistence FROM pg_class WHERE relname = 'abuse_counters'`,
    );
    expect(rows[0]?.relpersistence).toBe('u');
  });
});
