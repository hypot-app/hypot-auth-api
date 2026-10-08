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

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    // A targeted UPDATE, not a whole-row save: the use case read the account earlier, and
    // writing that copy back would undo anything committed since (a password change).
    await currentManager(this.dataSource)
      .createQueryBuilder()
      .update(UserSchema)
      .set({ email_verified_at: at, updated_at: at })
      .where('id = :userId AND email_verified_at IS NULL', { userId })
      .execute();
  }

  async updatePassword(userId: string, passwordHash: string, at: Date): Promise<boolean> {
    // A targeted UPDATE: nothing but the credential columns changes, so a concurrent confirmation survives.
    const result = await currentManager(this.dataSource)
      .createQueryBuilder()
      .update(UserSchema)
      .set({ password_hash: passwordHash, password_changed_at: at, updated_at: at })
      .where('id = :userId', { userId })
      .returning('id')
      .execute();
    return result.raw.length > 0;
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

  async findByIdInApp(appId: string, id: string): Promise<User | null> {
    const row = await currentManager(this.dataSource)
      .getRepository<UserRow>(UserSchema)
      .findOneBy({ id, app_id: appId });
    return row ? UserMapper.toDomain(row) : null;
  }
}
