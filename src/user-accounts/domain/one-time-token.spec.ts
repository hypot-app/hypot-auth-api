import { OneTimeToken } from './one-time-token';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const HOUR = 3_600_000;
const issue = (purpose: 'email_verification' | 'password_reset') =>
  OneTimeToken.issue({ id: 't1', userId: 'u1', purpose, tokenHash: Buffer.alloc(32, 1), now: NOW });

describe('OneTimeToken.issue', () => {
  it('lives 24 hours for email verification', () => {
    expect(issue('email_verification').expiresAt.getTime()).toBe(NOW.getTime() + 24 * HOUR);
  });

  it('lives 1 hour for password reset', () => {
    expect(issue('password_reset').expiresAt.getTime()).toBe(NOW.getTime() + HOUR);
  });

  it('starts unconsumed', () => {
    expect(issue('email_verification').consumedAt).toBeNull();
  });
});
