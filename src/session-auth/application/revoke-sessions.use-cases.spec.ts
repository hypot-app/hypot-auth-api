import { FixedClock } from '../../shared-kernel/clock';
import { CryptoTokenGenerator } from '../../shared-kernel/token-generator';
import { InMemorySessionRepository } from '../../../test/support/in-memory-session.repository';
import { RefreshToken } from '../domain/refresh-token';
import { Session } from '../domain/session';
import { RevokeAccountSessionsUseCase } from './revoke-account-sessions.use-case';
import { RevokeAllSessionsUseCase } from './revoke-all-sessions.use-case';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;
const GENERATOR = new CryptoTokenGenerator();

async function setup() {
  const clock = new FixedClock(T0);
  const sessions = new InMemorySessionRepository();
  const open = async (userId: string, absoluteSeconds = 30 * DAY_SECONDS) => {
    const session = Session.open({ id: `session-${sessions.sessions.size + 1}`, appId: 'app-1', userId, now: T0, absoluteTtlSeconds: absoluteSeconds });
    await sessions.open(session, RefreshToken.issue({ tokenHash: GENERATOR.generate().hash, session, now: T0, idleTtlSeconds: 7 * DAY_SECONDS }));
    return session.id;
  };
  return { clock, sessions, open };
}

describe('RevokeAccountSessionsUseCase', () => {
  it('revokes every active session of the account with the given reason, and returns how many', async () => {
    const t = await setup();
    const a = await t.open('user-ana');
    const b = await t.open('user-ana');
    t.clock.advanceMs(1_000);

    const revoked = await new RevokeAccountSessionsUseCase({ sessions: t.sessions, clock: t.clock }).execute({
      userId: 'user-ana',
      reason: 'password_changed',
    });

    expect(revoked).toBe(2);
    for (const id of [a, b]) {
      expect(t.sessions.sessions.get(id)).toMatchObject({ revokedAt: new Date(T0.getTime() + 1_000), revokedReason: 'password_changed' });
    }
  });

  it('leaves other accounts alone and keeps the reason of a session that was already revoked', async () => {
    const t = await setup();
    const mine = await t.open('user-ana');
    const gone = await t.open('user-ana');
    await t.sessions.revoke(gone, 'logout', T0);
    const other = await t.open('user-bob');

    const revoked = await new RevokeAccountSessionsUseCase({ sessions: t.sessions, clock: t.clock }).execute({
      userId: 'user-ana',
      reason: 'password_reset',
    });

    expect(revoked).toBe(1);
    expect(t.sessions.sessions.get(mine)!.revokedReason).toBe('password_reset');
    expect(t.sessions.sessions.get(gone)!.revokedReason).toBe('logout');
    expect(t.sessions.sessions.get(other)!.revokedAt).toBeNull();
  });

  it('returns 0 for an account with no sessions', async () => {
    const t = await setup();

    expect(await new RevokeAccountSessionsUseCase({ sessions: t.sessions, clock: t.clock }).execute({ userId: 'nobody', reason: 'password_reset' })).toBe(0);
  });
});

describe('RevokeAllSessionsUseCase', () => {
  it('revokes every active session of every account with ops_revoke_all, and returns the count', async () => {
    const t = await setup();
    const ids = [await t.open('user-ana'), await t.open('user-bob'), await t.open('user-ana')];

    const revoked = await new RevokeAllSessionsUseCase({ sessions: t.sessions, clock: t.clock }).execute();

    expect(revoked).toBe(3);
    for (const id of ids) expect(t.sessions.sessions.get(id)).toMatchObject({ revokedAt: T0, revokedReason: 'ops_revoke_all' });
  });

  it('does not count sessions that were already revoked or already over, and keeps the first reason', async () => {
    const t = await setup();
    const live = await t.open('user-ana');
    const done = await t.open('user-bob');
    await t.sessions.revoke(done, 'logout', T0);
    const expired = await t.open('user-cy', 60);
    t.clock.advanceMs(120_000);

    const revoked = await new RevokeAllSessionsUseCase({ sessions: t.sessions, clock: t.clock }).execute();

    expect(revoked).toBe(1);
    expect(t.sessions.sessions.get(live)!.revokedReason).toBe('ops_revoke_all');
    expect(t.sessions.sessions.get(done)!.revokedReason).toBe('logout');
    expect(t.sessions.sessions.get(expired)!.revokedAt).toBeNull();
  });
});
