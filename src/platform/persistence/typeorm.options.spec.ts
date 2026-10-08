import { buildTypeOrmOptions, DB_CONNECTION_TIMEOUT_MS, DB_POOL_MAX } from './typeorm.options';

describe('buildTypeOrmOptions', () => {
  const options = buildTypeOrmOptions({ url: 'postgres://u:p@localhost:5432/db' });

  it('targets postgres with the given url', () => {
    expect(options.type).toBe('postgres');
    expect(options).toMatchObject({ url: 'postgres://u:p@localhost:5432/db' });
  });

  it('sets the pg pool size explicitly instead of relying on the driver default', () => {
    expect(DB_POOL_MAX).toBe(10);
    expect(options).toMatchObject({ extra: { max: DB_POOL_MAX } });
  });

  it('bounds the wait for a pooled connection so pool exhaustion is an error, not a hang', () => {
    expect(DB_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(options).toMatchObject({ extra: { max: DB_POOL_MAX, connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS } });
  });

  it('never syncs the schema or auto-runs migrations', () => {
    expect(options.synchronize).toBe(false);
    expect(options.migrationsRun).toBe(false);
  });

  it('loads migrations from the migrations folder', () => {
    const migrations = options.migrations as string[];
    expect(migrations).toHaveLength(1);
    expect(migrations[0]).toMatch(/migrations[\\/]\*\.\{ts,js\}$/);
  });
});
