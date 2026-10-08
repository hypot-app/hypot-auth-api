import { Session, SESSION_REVOKED_REASONS } from './session';

const NOW = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;

describe('Session', () => {
  it('opens active, bound to its app and user, expiring after the absolute lifetime', () => {
    const session = Session.open({ id: 's1', appId: 'a1', userId: 'u1', now: NOW, absoluteTtlSeconds: 30 * DAY_SECONDS });

    expect(session).toMatchObject({ id: 's1', appId: 'a1', userId: 'u1', revokedAt: null, revokedReason: null });
    expect(session.createdAt).toEqual(NOW);
    expect(session.lastUsedAt).toEqual(NOW);
    expect(session.expiresAt).toEqual(new Date('2026-04-02T10:00:00.000Z'));
  });

  it('restores every stored field untouched', () => {
    const props = {
      id: 's1',
      appId: 'a1',
      userId: 'u1',
      createdAt: NOW,
      lastUsedAt: new Date('2026-03-04T10:00:00.000Z'),
      expiresAt: new Date('2026-04-02T10:00:00.000Z'),
      revokedAt: new Date('2026-03-05T10:00:00.000Z'),
      revokedReason: 'reuse_detected' as const,
    };

    expect({ ...Session.restore(props) }).toEqual(props);
  });

  it('knows the five revocation reasons of ADR 35', () => {
    expect([...SESSION_REVOKED_REASONS]).toEqual(['logout', 'reuse_detected', 'password_changed', 'password_reset', 'ops_revoke_all']);
  });
});
