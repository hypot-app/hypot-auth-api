import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from '../../src/platform/persistence/typeorm.options';

export interface TestDatabase {
  dataSource: DataSource;
  /** Empties every table except the migrations ledger. */
  truncate(): Promise<void>;
  /** Destroys the DataSource and stops the container. */
  teardown(): Promise<void>;
}

/**
 * Starts a throwaway Postgres container, initializes a TypeORM DataSource
 * against it and runs all migrations. Requires a running Docker daemon.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const dataSource = new DataSource(buildTypeOrmOptions({ url: container.getConnectionUri() }));
  await dataSource.initialize();
  await dataSource.runMigrations();

  return {
    dataSource,
    async truncate() {
      const rows: { tablename: string }[] = await dataSource.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
      );
      if (rows.length === 0) return;
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
      await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
    },
    async teardown() {
      if (dataSource.isInitialized) await dataSource.destroy();
      await container.stop();
    },
  };
}
