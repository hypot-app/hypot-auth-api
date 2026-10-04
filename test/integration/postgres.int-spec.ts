import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('Postgres test stack (integration)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it('boots Postgres and runs migrations', async () => {
    const rows = await db.dataSource.query('SELECT 1 AS ok');
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('truncate helper succeeds on a migrated database', async () => {
    await expect(db.truncate()).resolves.toBeUndefined();
  });
});
