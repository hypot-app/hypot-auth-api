import { currentManager, TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('TypeOrmUnitOfWork (integration)', () => {
  let db: TestDatabase;
  let uow: TypeOrmUnitOfWork;

  const insert = (name: string) =>
    currentManager(db.dataSource).query('INSERT INTO uow_probe (name) VALUES ($1)', [name]);
  const names = async (): Promise<string[]> => {
    const rows: { name: string }[] = await db.dataSource.query('SELECT name FROM uow_probe ORDER BY name');
    return rows.map((row) => row.name);
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.dataSource.query('CREATE TABLE uow_probe (name text PRIMARY KEY)');
    uow = new TypeOrmUnitOfWork(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('commits every write made through currentManager and returns the work result', async () => {
    const result = await uow.run(async () => {
      await insert('a');
      await insert('b');
      return 'done';
    });

    expect(result).toBe('done');
    expect(await names()).toEqual(['a', 'b']);
  });

  it('rolls back every write when the work throws, and rethrows', async () => {
    await expect(
      uow.run(async () => {
        await insert('a');
        await insert('b');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await names()).toEqual([]);
  });

  it('rolls back when a statement fails mid-transaction', async () => {
    await expect(
      uow.run(async () => {
        await insert('a');
        await insert('a'); // primary key violation
      }),
    ).rejects.toThrow(/duplicate key/);

    expect(await names()).toEqual([]);
  });

  it('writes are not visible outside the transaction until commit', async () => {
    let seenInside: string[] = [];
    let seenOutside: string[] = [];
    await uow.run(async () => {
      await insert('a');
      seenInside = (
        await currentManager(db.dataSource).query<{ name: string }[]>('SELECT name FROM uow_probe')
      ).map((row) => row.name);
      seenOutside = await names();
    });

    expect(seenInside).toEqual(['a']);
    expect(seenOutside).toEqual([]);
    expect(await names()).toEqual(['a']);
  });

  it('joins an enclosing transaction when nested', async () => {
    await expect(
      uow.run(async () => {
        await insert('outer');
        await uow.run(async () => {
          await insert('inner');
        });
        throw new Error('outer fails');
      }),
    ).rejects.toThrow('outer fails');

    expect(await names()).toEqual([]);
  });

  it('keeps concurrent units of work isolated from each other', async () => {
    const failing = uow.run(async () => {
      await insert('fails');
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('x');
    });
    const succeeding = uow.run(async () => {
      await insert('works');
    });

    await expect(failing).rejects.toThrow('x');
    await succeeding;
    expect(await names()).toEqual(['works']);
  });

  it('falls back to the default manager outside a unit of work', async () => {
    expect(currentManager(db.dataSource)).toBe(db.dataSource.manager);

    let inside: unknown;
    await uow.run(async () => {
      inside = currentManager(db.dataSource);
    });
    expect(inside).not.toBe(db.dataSource.manager);
  });
});
