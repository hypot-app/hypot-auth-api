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
 * How long a caller waits for a free pooled connection before the acquisition fails with an error. Without it
 * pg waits forever, so any bug that holds a connection while asking for another turns pool exhaustion into a
 * silent, permanent hang of the whole API; with it the request fails and the pool recovers.
 */
export const DB_CONNECTION_TIMEOUT_MS = 5000;

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
    extra: { max: DB_POOL_MAX, connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS },
    synchronize: false,
    migrationsRun: false,
  };
}
