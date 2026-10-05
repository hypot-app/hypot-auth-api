import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource, type EntitySchema } from 'typeorm';
import { buildTypeOrmOptions } from '../../src/platform/persistence/typeorm.options';

export interface TestDatabase {
  /** Connection URI of the container, for apps under test. */
  url: string;
  dataSource: DataSource;
  /** Empties every table except the migrations ledger. */
  truncate(): Promise<void>;
  /**
   * Reverts migrations, newest first, until the one whose class name starts with
   * `namePrefix` has been reverted too. Tests of an older migration use this so they
   * do not have to count the migrations added after it.
   */
  revertThrough(namePrefix: string): Promise<void>;
  /** Destroys the DataSource and stops the container. */
  teardown(): Promise<void>;
}

/**
 * Starts a throwaway Postgres container, initializes a TypeORM DataSource
 * against it and runs all migrations. Requires a running Docker daemon.
 */
export async function startTestDatabase(options: { entities?: EntitySchema[] } = {}): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:17-alpine').start();
  const url = container.getConnectionUri();
  const dataSource = new DataSource({ ...buildTypeOrmOptions({ url }), entities: options.entities ?? [] });
  await dataSource.initialize();
  await dataSource.runMigrations();

  return {
    url,
    dataSource,
    async truncate() {
      const rows: { tablename: string }[] = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
      );
      if (rows.length === 0) return;
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
      await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    },
    async revertThrough(namePrefix) {
      const isApplied = async (): Promise<boolean> => {
        const rows: unknown[] = await dataSource.query(`SELECT 1 FROM migrations WHERE name LIKE $1`, [`${namePrefix}%`]);
        return rows.length > 0;
      };
      while (await isApplied()) await dataSource.undoLastMigration();
    },
    async teardown() {
      if (dataSource.isInitialized) await dataSource.destroy();
      await container.stop();
    },
  };
}
