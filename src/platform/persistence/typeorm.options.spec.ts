import { buildTypeOrmOptions } from './typeorm.options';

describe('buildTypeOrmOptions', () => {
  const options = buildTypeOrmOptions({ url: 'postgres://u:p@localhost:5432/db' });

  it('targets postgres with the given url', () => {
    expect(options.type).toBe('postgres');
    expect(options).toMatchObject({ url: 'postgres://u:p@localhost:5432/db' });
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
