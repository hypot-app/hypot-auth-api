import { randomUUID } from 'node:crypto';
import { AppSchema, type AppRow } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

function row(overrides: Partial<AppRow> = {}): AppRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: randomUUID(),
    client_id: `client-${randomUUID()}`,
    name: 'Test app',
    client_type: 'public',
    client_secret_hash: null,
    redirect_uris: ['https://a.example/cb'],
    allowed_origins: ['https://a.example'],
    email_from: null,
    email_confirmation_url: null,
    password_reset_url: null,
    status: 'active',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('apps table (integration)', () => {
  let db: TestDatabase;
  const repo = () => db.dataSource.getRepository<AppRow>(AppSchema);

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('persists and reloads every column, including arrays and bytea', async () => {
    const hash = Buffer.alloc(32, 7);
    const saved = row({
      client_type: 'confidential',
      client_secret_hash: hash,
      redirect_uris: ['https://a.example/cb', 'https://a.example/cb2'],
      email_from: 'no-reply@a.example',
    });
    await repo().save(saved);

    const loaded = await repo().findOneByOrFail({ id: saved.id });
    expect(loaded.client_secret_hash?.equals(hash)).toBe(true);
    expect(loaded.redirect_uris).toEqual(saved.redirect_uris);
    expect(loaded.allowed_origins).toEqual(saved.allowed_origins);
    expect(loaded.email_from).toBe('no-reply@a.example');
    expect(loaded.status).toBe('active');
  });

  it('enforces a unique client_id', async () => {
    await repo().save(row({ client_id: 'dup' }));
    await expect(repo().save(row({ client_id: 'dup' }))).rejects.toThrow(/duplicate key/);
  });

  it('stores null email link URLs as null', async () => {
    const saved = row({ email_confirmation_url: null, password_reset_url: null });
    await repo().save(saved);
    const loaded = await repo().findOneByOrFail({ id: saved.id });
    expect(loaded.email_confirmation_url).toBeNull();
    expect(loaded.password_reset_url).toBeNull();
  });

  it('stores the email link URLs as given', async () => {
    const saved = row({
      email_confirmation_url: 'https://a.example/confirm',
      password_reset_url: 'https://a.example/reset',
    });
    await repo().save(saved);
    const loaded = await repo().findOneByOrFail({ id: saved.id });
    expect(loaded.email_confirmation_url).toBe('https://a.example/confirm');
    expect(loaded.password_reset_url).toBe('https://a.example/reset');
  });

  it('rejects a confidential app without a secret hash and a public app with one', async () => {
    await expect(repo().save(row({ client_type: 'confidential', client_secret_hash: null }))).rejects.toThrow();
    await expect(repo().save(row({ client_type: 'public', client_secret_hash: Buffer.alloc(32) }))).rejects.toThrow();
  });

  describe('CreateApps migration', () => {
    const tableExists = async (): Promise<boolean> => {
      const rows: { exists: boolean }[] = await db.dataSource.query(`SELECT to_regclass('public.apps') IS NOT NULL AS exists`);
      return rows[0].exists;
    };
    const typeCount = async (): Promise<number> => {
      const rows: { count: string }[] = await db.dataSource.query(
        `SELECT count(*) FROM pg_type WHERE typname IN ('apps_client_type_enum', 'apps_status_enum')`,
      );
      return Number(rows[0].count);
    };

    it('is reversible: up -> down -> up', async () => {
      expect(await tableExists()).toBe(true);

      // Later migrations reference apps, so they are undone first.
      await db.revertThrough('CreateApps');
      expect(await tableExists()).toBe(false);
      expect(await typeCount()).toBe(0);

      await db.dataSource.runMigrations();
      expect(await tableExists()).toBe(true);
      expect(await typeCount()).toBe(2);
    });
  });

  describe('AppEmailLinkUrls migration', () => {
    const appColumns = async (): Promise<Record<string, string>> => {
      const rows: { column_name: string; is_nullable: string }[] = await db.dataSource.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'apps' AND column_name IN
           ('email_confirmation_url', 'password_reset_url', 'post_reset_redirect_uri')`,
      );
      return Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]));
    };

    it('up adds two nullable URL columns and drops post_reset_redirect_uri', async () => {
      expect(await appColumns()).toEqual({ email_confirmation_url: 'YES', password_reset_url: 'YES' });
    });

    it('is reversible: down restores post_reset_redirect_uri and drops both URL columns; up again', async () => {
      await db.revertThrough('AppEmailLinkUrls');
      expect(await appColumns()).toEqual({ post_reset_redirect_uri: 'YES' });

      await db.dataSource.runMigrations();
      expect(await appColumns()).toEqual({ email_confirmation_url: 'YES', password_reset_url: 'YES' });
    });
  });
});
