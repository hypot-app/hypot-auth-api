import { SESSION_REVOKED_REASONS } from '../../domain/session';
import { SessionMapper } from './session.mapper';
import type { SessionRow } from './session.schema';

const row = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: '3b1f7c9e-0000-4000-8000-000000000001',
  app_id: '3b1f7c9e-0000-4000-8000-0000000000a1',
  user_id: '3b1f7c9e-0000-4000-8000-0000000000b1',
  created_at: new Date('2026-03-03T10:00:00.000Z'),
  last_used_at: new Date('2026-03-04T10:00:00.000Z'),
  expires_at: new Date('2026-04-02T10:00:00.000Z'),
  revoked_at: null,
  revoked_reason: null,
  ...overrides,
});

describe('SessionMapper', () => {
  it('round-trips an active session with a null revoked_at and revoked_reason', () => {
    const stored = row();

    const session = SessionMapper.toDomain(stored);

    expect(session).toMatchObject({ id: stored.id, appId: stored.app_id, userId: stored.user_id, revokedAt: null, revokedReason: null });
    expect(session.lastUsedAt).toEqual(stored.last_used_at);
    expect(SessionMapper.toPersistence(session)).toEqual(stored);
  });

  it.each(SESSION_REVOKED_REASONS)('round-trips a session revoked for %s', (reason) => {
    const stored = row({ revoked_at: new Date('2026-03-05T10:00:00.000Z'), revoked_reason: reason });

    expect(SessionMapper.toPersistence(SessionMapper.toDomain(stored))).toEqual(stored);
  });
});
