import { OneTimeToken } from '../../domain/one-time-token';
import { OneTimeTokenMapper } from './one-time-token.mapper';
import type { OneTimeTokenRow } from './one-time-token.schema';

const rowOf = (overrides: Partial<OneTimeTokenRow> = {}): OneTimeTokenRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  purpose: 'email_verification',
  token_hash: Buffer.alloc(32, 7),
  expires_at: new Date('2026-01-02T00:00:00.000Z'),
  consumed_at: new Date('2026-01-01T12:00:00.000Z'),
  ...overrides,
});

describe('OneTimeTokenMapper', () => {
  it('round-trips a consumed token row -> domain -> row', () => {
    const row = rowOf();
    const token = OneTimeTokenMapper.toDomain(row);
    expect(token).toBeInstanceOf(OneTimeToken);
    expect(OneTimeTokenMapper.toPersistence(token)).toEqual(row);
  });

  it('round-trips an unconsumed password-reset token', () => {
    const row = rowOf({ purpose: 'password_reset', consumed_at: null });
    expect(OneTimeTokenMapper.toPersistence(OneTimeTokenMapper.toDomain(row))).toEqual(row);
  });
});
