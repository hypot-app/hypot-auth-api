import { Test } from '@nestjs/testing';
import { DEFAULT_POLICIES } from '../domain/policy';
import { ABUSE_CONFIG_PROVIDERS, ABUSE_ENV, ABUSE_POLICIES, AbuseConfigError, loadAbusePolicies } from './abuse-config';

describe('loadAbusePolicies: ABUSE_<SCOPE>_* (ADR 36)', () => {
  it('returns the ADR 36 defaults for an environment that sets none, ignoring unrelated variables', () => {
    expect(loadAbusePolicies({ DATABASE_URL: 'postgres://x', PORT: 'not-a-number' })).toEqual(DEFAULT_POLICIES);
  });

  it('overrides one field and keeps the other defaults', () => {
    const policies = loadAbusePolicies({ ABUSE_LOGIN_ACCOUNT_IP_LIMIT: '3' });
    expect(policies.login_account_ip).toEqual({ limit: 3, windowSeconds: 900, blockSeconds: 900 });
    expect(policies.email_account).toEqual(DEFAULT_POLICIES.email_account);
  });

  it('overrides window and block seconds', () => {
    const policies = loadAbusePolicies({
      ABUSE_LOGIN_ACCOUNT_WINDOW_SECONDS: '7200',
      ABUSE_LOGIN_ACCOUNT_BLOCK_SECONDS: '60',
      ABUSE_REFRESH_IP_WINDOW_SECONDS: '30',
    });
    expect(policies.login_account).toEqual({ limit: 50, windowSeconds: 7200, blockSeconds: 60 });
    expect(policies.refresh_ip).toEqual({ limit: 60, windowSeconds: 30, blockSeconds: null });
  });

  it('ignores a block length for a scope that has no lockout', () => {
    expect(loadAbusePolicies({ ABUSE_EMAIL_IP_BLOCK_SECONDS: '60' }).email_ip).toEqual(DEFAULT_POLICIES.email_ip);
  });

  it.each(['0', '-5', '1.5', 'abc', ''])('rejects %p as a limit, naming only the variable', (value) => {
    const act = () => loadAbusePolicies({ ABUSE_EMAIL_IP_LIMIT: value });
    expect(act).toThrow(AbuseConfigError);
    expect(act).toThrow('ABUSE_EMAIL_IP_LIMIT');
  });
});

describe('abuse-protection boot', () => {
  const compile = (env: Record<string, string | undefined>) =>
    Test.createTestingModule({ providers: ABUSE_CONFIG_PROVIDERS }).overrideProvider(ABUSE_ENV).useValue(env).compile();

  it('provides the policies parsed from the environment', async () => {
    const moduleRef = await compile({ ABUSE_EMAIL_ACCOUNT_LIMIT: '9' });
    expect(moduleRef.get(ABUSE_POLICIES).email_account.limit).toBe(9);
  });

  it('refuses to start on a bad ABUSE_* value instead of running with unusable limits', async () => {
    await expect(compile({ ABUSE_EMAIL_IP_LIMIT: '0' })).rejects.toThrow('ABUSE_EMAIL_IP_LIMIT');
  });
});
