import { User } from '../../domain/user';
import type { UserRow } from './user.schema';

export const UserMapper = {
  toDomain(row: UserRow): User {
    return User.restore({
      id: row.id,
      appId: row.app_id,
      email: row.email,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
      passwordChangedAt: row.password_changed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  },

  toPersistence(user: User): UserRow {
    return {
      id: user.id,
      app_id: user.appId,
      email: user.email,
      password_hash: user.passwordHash,
      email_verified_at: user.emailVerifiedAt,
      password_changed_at: user.passwordChangedAt,
      created_at: user.createdAt,
      updated_at: user.updatedAt,
    };
  },
};
