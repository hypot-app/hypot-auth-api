import { DataSource } from 'typeorm';
import { buildTypeOrmOptions } from './typeorm.options';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required to use the TypeORM CLI');
}

// Standalone DataSource for the TypeORM CLI (migration:* scripts).
export default new DataSource(buildTypeOrmOptions({ url }));
