import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('RetentionIndexes migration (integration, ADR 35)', () => {
  let db: TestDatabase;
  const indexDefinition = async (name: string): Promise<string | undefined> =>
    (
      await db.dataSource.query<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE indexname = $1`, [name])
    )[0]?.indexdef;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it('indexes one_time_tokens by expiry for the retention sweep', async () => {
    expect(await indexDefinition('IDX_one_time_tokens_expires_at')).toMatch(
      /ON public\.one_time_tokens USING btree \(expires_at\)$/,
    );
  });

  it('indexes only the sent and failed outbox rows by creation time, never the pending ones', async () => {
    const definition = await indexDefinition('IDX_email_outbox_retention');
    expect(definition).toMatch(/ON public\.email_outbox USING btree \(created_at\)/);
    expect(definition).toMatch(/WHERE \(status = ANY \(ARRAY\['sent'::email_outbox_status_enum, 'failed'::email_outbox_status_enum\]\)\)$/);
  });

  it('reverts natively to the previous schema and applies again', async () => {
    await db.revertThrough('RetentionIndexes');
    expect(await indexDefinition('IDX_one_time_tokens_expires_at')).toBeUndefined();
    expect(await indexDefinition('IDX_email_outbox_retention')).toBeUndefined();
    // The previous migration's own objects are untouched.
    expect(await indexDefinition('IDX_email_outbox_pending_due')).toBeDefined();
    expect(await indexDefinition('IDX_one_time_tokens_user_purpose')).toBeDefined();

    await db.dataSource.runMigrations();
    expect(await indexDefinition('IDX_one_time_tokens_expires_at')).toBeDefined();
    expect(await indexDefinition('IDX_email_outbox_retention')).toBeDefined();
  });
});
