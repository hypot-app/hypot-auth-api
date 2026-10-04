import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { App } from '../../domain/app';
import type { AppRepository } from '../../domain/app.repository';
import { AppMapper } from './app.mapper';
import { AppSchema, type AppRow } from './app.schema';

@Injectable()
export class TypeOrmAppRepository implements AppRepository {
  constructor(private readonly dataSource: DataSource) {}

  async save(app: App): Promise<void> {
    await currentManager(this.dataSource).getRepository<AppRow>(AppSchema).save(AppMapper.toPersistence(app));
  }

  async findByClientId(clientId: string): Promise<App | null> {
    const row = await currentManager(this.dataSource)
      .getRepository<AppRow>(AppSchema)
      .findOneBy({ client_id: clientId });
    return row ? AppMapper.toDomain(row) : null;
  }
}
