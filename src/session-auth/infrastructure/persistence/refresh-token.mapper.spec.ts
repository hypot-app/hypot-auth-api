import { RefreshTokenMapper } from './refresh-token.mapper';
import type { RefreshTokenRow } from './refresh-token.schema';

const row = (overrides: Partial<RefreshTokenRow> = {}): RefreshTokenRow => ({
  token_hash: Buffer.alloc(32, 1),
  session_id: '3b1f7c9e-0000-4000-8000-000000000001',
  created_at: new Date('2026-03-03T10:00:00.000Z'),
  expires_at: new Date('2026-03-10T10:00:00.000Z'),
  consumed_at: null,
  replaced_by_hash: null,
  consumed_ip_hash: null,
  grace_used_at: null,
  revoked_at: null,
  ...overrides,
});

describe('RefreshTokenMapper', () => {
  it('round-trips an unused token: consumed_at, replaced_by_hash, consumed_ip_hash, grace_used_at and revoked_at stay null', () => {
    const stored = row();

    const token = RefreshTokenMapper.toDomain(stored);

    expect(token).toMatchObject({
      sessionId: stored.session_id,
      consumedAt: null,
      replacedByHash: null,
      consumedIpHash: null,
      graceUsedAt: null,
      revokedAt: null,
    });
    expect(token.tokenHash).toEqual(stored.token_hash);
    expect(RefreshTokenMapper.toPersistence(token)).toEqual(stored);
  });

  it('round-trips a rotated token with its grace-window columns set', () => {
    const stored = row({
      consumed_at: new Date('2026-03-04T10:00:00.000Z'),
      replaced_by_hash: Buffer.alloc(32, 2),
      consumed_ip_hash: Buffer.alloc(32, 3),
      grace_used_at: new Date('2026-03-04T10:00:05.000Z'),
      revoked_at: new Date('2026-03-04T10:00:06.000Z'),
    });

    expect(RefreshTokenMapper.toPersistence(RefreshTokenMapper.toDomain(stored))).toEqual(stored);
  });
});
