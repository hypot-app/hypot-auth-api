import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

export interface DatabaseSettings {
  url: string;
}

/**
 * Size of the pg connection pool, shared by HTTP requests and the outbox poller.
 * Explicit so it is a decision, not the driver default. The poller holds a connection
 * only for the short claim and completion statements (never during an SMTP send), so it
 * needs at most one at a time per process; the rest serve requests. Keep this above the
 * poller concurrency plus the expected parallel requests (ADR 30).
 */
export const DB_POOL_MAX = 10;

/**
 * Single source of truth for TypeORM options. The Nest module and the
 * standalone CLI DataSource both build from this, so the app and the
 * migrations never drift.
 */
export function buildTypeOrmOptions(settings: DatabaseSettings): DataSourceOptions {
  return {
    type: 'postgres',
    url: settings.url,
    entities: [],
    migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
    extra: { max: DB_POOL_MAX },
    synchronize: false,
    migrationsRun: false,
  };
}
