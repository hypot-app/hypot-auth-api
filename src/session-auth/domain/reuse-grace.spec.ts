import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { hashClientIp } from './ip-hash';
import { isGraceEligible } from './reuse-grace';
import type { TokenState } from './session.repository';

const CONSUMED_AT = new Date('2026-03-03T10:00:00.000Z');
const IP = hashClientIp(ClientIp.from('203.0.113.9', undefined));
const OTHER_IP = hashClientIp(ClientIp.from('198.51.100.7', undefined));
const at = (ms: number) => new Date(CONSUMED_AT.getTime() + ms);

/** A token rotated at CONSUMED_AT from IP, never forgiven, in an active session. */
const rotated = (overrides: Partial<TokenState> = {}): TokenState => ({
  sessionId: 'session-1',
  appId: 'app-1',
  userId: 'user-1',
  tokenExpiresAt: at(7 * 86_400_000),
  consumedAt: CONSUMED_AT,
  consumedIpHash: IP,
  replacedByHash: Buffer.from('successor'),
  graceUsedAt: null,
  tokenRevokedAt: null,
  sessionExpiresAt: at(30 * 86_400_000),
  sessionRevokedAt: null,
  ...overrides,
});

describe('isGraceEligible', () => {
  const rules: { name: string; state: TokenState; now: Date; ipHash?: Buffer; graceSeconds?: number; eligible: boolean }[] = [
    { name: 'inside the window from the same IP', state: rotated(), now: at(5_000), eligible: true },
    { name: 'right after the rotation', state: rotated(), now: at(0), eligible: true },
    { name: 'exactly at the end of the window', state: rotated(), now: at(10_000), eligible: true },
    { name: 'one millisecond after the window', state: rotated(), now: at(10_001), eligible: false },
    { name: 'from another IP', state: rotated(), now: at(1_000), ipHash: OTHER_IP, eligible: false },
    { name: 'with no IP recorded for the rotation', state: rotated({ consumedIpHash: null }), now: at(1_000), eligible: false },
    { name: 'when the window is 0', state: rotated(), now: at(0), graceSeconds: 0, eligible: false },
    { name: 'when the grace was already used', state: rotated({ graceUsedAt: at(2_000) }), now: at(3_000), eligible: false },
    { name: 'for a token that was never rotated', state: rotated({ consumedAt: null, consumedIpHash: null, replacedByHash: null }), now: at(1_000), eligible: false },
    { name: 'for a token with revoked_at', state: rotated({ tokenRevokedAt: at(500) }), now: at(1_000), eligible: false },
    { name: 'for a rotated token with no recorded successor', state: rotated({ replacedByHash: null }), now: at(1_000), eligible: false },
    { name: 'when the session is revoked', state: rotated({ sessionRevokedAt: at(500) }), now: at(1_000), eligible: false },
    { name: 'when the session expired', state: rotated({ sessionExpiresAt: at(1_000) }), now: at(1_000), eligible: false },
    { name: 'one millisecond before the session expires', state: rotated({ sessionExpiresAt: at(1_001) }), now: at(1_000), eligible: true },
    { name: 'a longer configured window', state: rotated(), now: at(25_000), graceSeconds: 30, eligible: true },
  ];

  it.each(rules)('is $eligible $name', ({ state, now, ipHash = IP, graceSeconds = 10, eligible }) => {
    expect(isGraceEligible(state, { now, ipHash, graceSeconds })).toBe(eligible);
  });
});
