import { randomUUID } from 'node:crypto';
import { AppSchema, type AppRow } from '../../src/app-registry/infrastructure/persistence/app.schema';
import {
  EmailOutboxSchema,
  type EmailOutboxRow,
} from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function appRow(): AppRow {
  return {
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
  };
}

function outboxRow(appId: string, overrides: Partial<EmailOutboxRow> = {}): EmailOutboxRow {
  return {
    id: randomUUID(),
    app_id: appId,
    to_address: 'ana@example.com',
    template: 'confirmation',
    payload: { token: 'raw-token-value' },
    status: 'pending',
    attempts: 0,
    next_attempt_at: NOW,
    last_error: null,
    locked_until: null,
    created_at: NOW,
    ...overrides,
  };
}

describe('email_outbox table (integration)', () => {
  let db: TestDatabase;
  let appId: string;
  const repo = () => db.dataSource.getRepository<EmailOutboxRow>(EmailOutboxSchema);

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, EmailOutboxSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    const app = appRow();
    await db.dataSource.getRepository<AppRow>(AppSchema).save(app);
    appId = app.id;
  });

  it('rejects an unknown status', async () => {
    await expect(repo().save(outboxRow(appId, { status: 'weird' as EmailOutboxRow['status'] }))).rejects.toThrow(
      /invalid input value for enum/,
    );
  });

  it('rejects a row for a nonexistent app', async () => {
    await expect(repo().save(outboxRow(randomUUID()))).rejects.toThrow(/violates foreign key constraint/);
  });

  describe('CreateEmailOutbox migration', () => {
    const state = async (): Promise<{ table: boolean; types: number }> => {
      const t: { exists: boolean }[] = await db.dataSource.query(
        `SELECT to_regclass('public.email_outbox') IS NOT NULL AS exists`,
      );
      const e: { count: string }[] = await db.dataSource.query(
        `SELECT count(*) FROM pg_type WHERE typname = 'email_outbox_status_enum'`,
      );
      return { table: t[0].exists, types: Number(e[0].count) };
    };

    it('is reversible: up -> down -> up', async () => {
      expect(await state()).toEqual({ table: true, types: 1 });

      await db.revertThrough('CreateEmailOutbox');
      expect(await state()).toEqual({ table: false, types: 0 });
      // The apps table from the earlier migration must survive the down.
      const apps: { exists: boolean }[] = await db.dataSource.query(`SELECT to_regclass('public.apps') IS NOT NULL AS exists`);
      expect(apps[0].exists).toBe(true);

      await db.dataSource.runMigrations();
      expect(await state()).toEqual({ table: true, types: 1 });
    });
  });
});
