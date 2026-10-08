import { startTestDatabase, type TestDatabase } from '../support/postgres';

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
}

describe('auth_sessions and refresh_tokens tables (integration, ADR 35)', () => {
  let db: TestDatabase;
  const query = <T>(sql: string, params: unknown[] = []): Promise<T[]> => db.dataSource.query(sql, params);

  const columns = async (table: string): Promise<Record<string, string>> => {
    const rows = await query<ColumnRow>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1`,
      [table],
    );
    return Object.fromEntries(rows.map((row) => [row.column_name, `${row.data_type}${row.is_nullable === 'YES' ? '?' : ''}`]));
  };
  const indexedColumns = async (table: string): Promise<string[]> =>
    (
      await query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND indexname NOT LIKE 'PK\\_%'`, [table])
    ).map((row) => /\(([^)]+)\)/.exec(row.indexdef)?.[1] ?? '');
  const foreignKeys = async (table: string): Promise<string[]> =>
    (
      await query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f' ORDER BY 1`,
        [table],
      )
    ).map((row) => row.definition);
  const exists = async (name: string): Promise<boolean> =>
    (await query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [name]))[0]!.exists;
  const enumLabels = async (): Promise<string[]> =>
    (
      await query<{ enumlabel: string }>(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'auth_sessions_revoked_reason_enum' ORDER BY e.enumsortorder`,
      )
    ).map((row) => row.enumlabel);

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it('creates auth_sessions bound to an app and a user, with an absolute expiry', async () => {
    expect(await columns('auth_sessions')).toEqual({
      id: 'uuid',
      app_id: 'uuid',
      user_id: 'uuid',
      created_at: 'timestamp with time zone',
      last_used_at: 'timestamp with time zone',
      expires_at: 'timestamp with time zone',
      revoked_at: 'timestamp with time zone?',
      revoked_reason: 'USER-DEFINED?',
    });
    expect(await foreignKeys('auth_sessions')).toEqual([
      'FOREIGN KEY (app_id) REFERENCES apps(id)',
      'FOREIGN KEY (user_id) REFERENCES users(id)',
    ]);
  });

  it('indexes sessions by user and by expiry', async () => {
    expect((await indexedColumns('auth_sessions')).sort()).toEqual(['expires_at', 'user_id']);
  });

  it('allows every revocation reason, including ops_revoke_all', async () => {
    expect(await enumLabels()).toEqual(['logout', 'reuse_detected', 'password_changed', 'password_reset', 'ops_revoke_all']);
  });

  it('creates refresh_tokens keyed by the token hash, with the grace-window columns', async () => {
    expect(await columns('refresh_tokens')).toEqual({
      token_hash: 'bytea',
      session_id: 'uuid',
      created_at: 'timestamp with time zone',
      expires_at: 'timestamp with time zone',
      consumed_at: 'timestamp with time zone?',
      replaced_by_hash: 'bytea?',
      consumed_ip_hash: 'bytea?',
      grace_used_at: 'timestamp with time zone?',
      revoked_at: 'timestamp with time zone?',
    });
    const primaryKey = await query<{ column_name: string }>(
      `SELECT a.attname AS column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = 'refresh_tokens'::regclass AND i.indisprimary`,
    );
    expect(primaryKey.map((row) => row.column_name)).toEqual(['token_hash']);
    expect(await foreignKeys('refresh_tokens')).toEqual(['FOREIGN KEY (session_id) REFERENCES auth_sessions(id)']);
    expect(await indexedColumns('refresh_tokens')).toEqual(['session_id']);
  });

  it('is reversible: up -> down (drops both tables and the enum) -> up', async () => {
    await db.revertThrough('CreateAuthSessions');
    expect(await exists('public.auth_sessions')).toBe(false);
    expect(await exists('public.refresh_tokens')).toBe(false);
    expect(await enumLabels()).toEqual([]);

    await db.dataSource.runMigrations();
    expect(await exists('public.auth_sessions')).toBe(true);
    expect(await exists('public.refresh_tokens')).toBe(true);
    expect(await enumLabels()).toContain('ops_revoke_all');
  });
});
