import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';

export interface DatabaseSettings {
  url: string;
}

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
    synchronize: false,
    migrationsRun: false,
  };
}
