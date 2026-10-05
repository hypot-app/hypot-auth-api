import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { User } from '../../domain/user';
import type { UserRepository } from '../../domain/user.repository';
import { UserMapper } from './user.mapper';
import { UserSchema, type UserRow } from './user.schema';

@Injectable()
export class TypeOrmUserRepository implements UserRepository {
  constructor(private readonly dataSource: DataSource) {}

  async add(user: User): Promise<boolean> {
    // ON CONFLICT DO NOTHING keeps a duplicate from aborting the surrounding transaction
    // and makes the check atomic: no read-then-insert race between two signups.
    const result = await currentManager(this.dataSource)
      .createQueryBuilder()
      .insert()
      .into(UserSchema)
      .values(UserMapper.toPersistence(user))
      .orIgnore()
      .returning('id')
      .execute();
    return result.raw.length > 0;
  }

  async save(user: User): Promise<void> {
    await currentManager(this.dataSource).getRepository<UserRow>(UserSchema).save(UserMapper.toPersistence(user));
  }

  async findByAppAndEmail(appId: string, email: string): Promise<User | null> {
    const row = await currentManager(this.dataSource)
      .getRepository<UserRow>(UserSchema)
      .findOneBy({ app_id: appId, email });
    return row ? UserMapper.toDomain(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const row = await currentManager(this.dataSource).getRepository<UserRow>(UserSchema).findOneBy({ id });
    return row ? UserMapper.toDomain(row) : null;
  }
}
