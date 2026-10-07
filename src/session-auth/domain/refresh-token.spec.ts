import { RefreshToken } from './refresh-token';

const NOW = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;
const hash = (byte: number): Buffer => Buffer.alloc(32, byte);

describe('RefreshToken', () => {
  const sessionEndingIn = (days: number) => ({ id: 's1', expiresAt: new Date(NOW.getTime() + days * DAY_SECONDS * 1000) });

  it('issues an unused token that expires after the idle TTL', () => {
    const token = RefreshToken.issue({ tokenHash: hash(1), session: sessionEndingIn(30), now: NOW, idleTtlSeconds: 7 * DAY_SECONDS });

    expect(token.tokenHash).toEqual(hash(1));
    expect(token).toMatchObject({
      sessionId: 's1',
      consumedAt: null,
      replacedByHash: null,
      consumedIpHash: null,
      graceUsedAt: null,
      revokedAt: null,
    });
    expect(token.createdAt).toEqual(NOW);
    expect(token.expiresAt).toEqual(new Date('2026-03-10T10:00:00.000Z'));
  });

  it('never outlives its session', () => {
    const token = RefreshToken.issue({ tokenHash: hash(1), session: sessionEndingIn(2), now: NOW, idleTtlSeconds: 7 * DAY_SECONDS });

    expect(token.expiresAt).toEqual(new Date('2026-03-05T10:00:00.000Z'));
  });

  it('keeps the idle expiry when it is exactly the session expiry', () => {
    const token = RefreshToken.issue({ tokenHash: hash(1), session: sessionEndingIn(7), now: NOW, idleTtlSeconds: 7 * DAY_SECONDS });

    expect(token.expiresAt).toEqual(new Date('2026-03-10T10:00:00.000Z'));
  });

  it('restores every stored field untouched', () => {
    const props = {
      tokenHash: hash(1),
      sessionId: 's1',
      createdAt: NOW,
      expiresAt: new Date('2026-03-10T10:00:00.000Z'),
      consumedAt: new Date('2026-03-04T10:00:00.000Z'),
      replacedByHash: hash(2),
      consumedIpHash: hash(3),
      graceUsedAt: new Date('2026-03-04T10:00:05.000Z'),
      revokedAt: new Date('2026-03-04T10:00:06.000Z'),
    };

    expect({ ...RefreshToken.restore(props) }).toEqual(props);
  });
});
