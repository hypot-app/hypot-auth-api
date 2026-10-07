import { CounterKey } from './counter-key';
import { DEFAULT_POLICIES, resolvePolicies } from './policy';

describe('DEFAULT_POLICIES (ADR 36)', () => {
  it('has the documented limits, windows and block lengths', () => {
    expect(DEFAULT_POLICIES).toEqual({
      login_ip: { limit: 100, windowSeconds: 900, blockSeconds: null },
      login_account_ip: { limit: 5, windowSeconds: 900, blockSeconds: 900 },
      login_account: { limit: 50, windowSeconds: 3600, blockSeconds: 900 },
      email_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
      reset_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
      confirm_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
      refresh_ip: { limit: 60, windowSeconds: 900, blockSeconds: null },
      email_account: { limit: 3, windowSeconds: 3600, blockSeconds: null },
    });
  });
});

describe('resolvePolicies', () => {
  it('overrides only the given fields of the given scope', () => {
    const policies = resolvePolicies({ login_account_ip: { limit: 3 }, email_ip: { windowSeconds: 60 } });
    expect(policies.login_account_ip).toEqual({ limit: 3, windowSeconds: 900, blockSeconds: 900 });
    expect(policies.email_ip).toEqual({ limit: 20, windowSeconds: 60, blockSeconds: null });
    expect(policies.login_ip).toEqual(DEFAULT_POLICIES.login_ip);
  });
});

describe('CounterKey', () => {
  it('is a 32-byte SHA-256 digest, stable for the same input', () => {
    const key = CounterKey.of('login_ip', ['app-1', '203.0.113.9']);
    expect(key).toHaveLength(32);
    expect(key.equals(CounterKey.of('login_ip', ['app-1', '203.0.113.9']))).toBe(true);
  });

  it('normalizes case and surrounding whitespace of the parts', () => {
    const key = CounterKey.of('email_account', ['app-1', 'User@Example.com']);
    expect(key.equals(CounterKey.of('email_account', ['app-1', ' user@example.com ']))).toBe(true);
  });

  it('keeps reset_ip, confirm_ip and refresh_ip apart for the same IP', () => {
    const keys = [
      CounterKey.of('reset_ip', ['203.0.113.9']),
      CounterKey.of('confirm_ip', ['203.0.113.9']),
      CounterKey.of('refresh_ip', ['203.0.113.9']),
    ].map((key) => key.toString('hex'));
    expect(new Set(keys).size).toBe(3);
  });

  it('does not let part boundaries blur', () => {
    const a = CounterKey.of('login_account_ip', ['ab', 'c']);
    expect(a.equals(CounterKey.of('login_account_ip', ['a', 'bc']))).toBe(false);
    expect(a.equals(CounterKey.of('login_account_ip', ['ab:c']))).toBe(false);
  });
});
