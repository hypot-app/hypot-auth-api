import { User } from '../../domain/user';
import { UserMapper } from './user.mapper';
import type { UserRow } from './user.schema';

const rowOf = (overrides: Partial<UserRow> = {}): UserRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  app_id: '22222222-2222-4222-8222-222222222222',
  email: 'ana@example.com',
  password_hash: '$2b$12$hash',
  email_verified_at: new Date('2026-01-02T00:00:00.000Z'),
  password_changed_at: new Date('2026-01-01T00:00:00.000Z'),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

describe('UserMapper', () => {
  it('round-trips a confirmed account row -> domain -> row', () => {
    const row = rowOf();
    const user = UserMapper.toDomain(row);
    expect(user).toBeInstanceOf(User);
    expect(user.isConfirmed()).toBe(true);
    expect(UserMapper.toPersistence(user)).toEqual(row);
  });

  it('round-trips an unconfirmed account', () => {
    const row = rowOf({ email_verified_at: null });
    const user = UserMapper.toDomain(row);
    expect(user.isConfirmed()).toBe(false);
    expect(UserMapper.toPersistence(user)).toEqual(row);
  });
});
