import { accountsHarness, BLOG_CLIENT_ID, SHOP_CLIENT_ID, START } from '../../../test/support/accounts-harness';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { RateLimitedError } from '../../abuse-protection/domain/rate-limited-error';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';
import { hashToken } from '../../shared-kernel/token-generator';

const IP = ClientIp.from('203.0.113.7', undefined);
const OTHER_IP = ClientIp.from('198.51.100.9', undefined);

const signupInput = (
  overrides: Partial<{ clientId: string; email: string; password: string; origin: string; ip: ClientIp }> = {},
) => ({
  clientId: SHOP_CLIENT_ID,
  email: 'Ana@Example.com',
  password: 'correct horse',
  ip: IP,
  ...overrides,
});

const failureOf = (result: { ok: boolean; error?: { code: string; message: string } }) =>
  result.ok ? null : `${result.error?.code}: ${result.error?.message}`;

describe('SignupUseCase', () => {
  it('creates an unconfirmed account with a hashed password and a lowercase email', async () => {
    const h = await accountsHarness();

    expect((await h.signup.execute(signupInput())).ok).toBe(true);

    const user = await h.users.findByAppAndEmail(h.shop.id, 'ana@example.com');
    expect(user?.passwordHash).toBe('hashed:correct horse');
    expect(user?.isConfirmed()).toBe(false);
    expect(user?.createdAt).toEqual(START);
  });

  it('queues a confirmation email whose token is stored only as a hash, valid for 24 hours', async () => {
    const h = await accountsHarness();
    await h.signup.execute(signupInput());

    const [email, ...rest] = h.queued();
    expect(rest).toEqual([]);
    expect(email).toMatchObject({ template: 'confirmation', to: 'ana@example.com', appId: h.shop.id, status: 'pending' });
    expect(Object.keys(email!.payload)).toEqual(['token']);
    expect(JSON.stringify(email)).not.toContain('correct horse');

    const [stored, ...others] = [...h.oneTimeTokens.tokens.values()];
    expect(others).toEqual([]);
    expect(stored!.tokenHash.equals(hashToken(email!.payload['token']!))).toBe(true);
    expect(stored!.purpose).toBe('email_verification');
    expect(stored!.expiresAt.getTime()).toBe(START.getTime() + 24 * 3_600_000);
    expect(JSON.stringify(stored)).not.toContain(email!.payload['token']!);
  });

  it('answers a duplicate in the same app like a signup, creating nothing and sending the account-exists notice', async () => {
    const h = await accountsHarness();
    await h.signup.execute(signupInput());

    const second = await h.signup.execute(signupInput({ email: 'ANA@example.COM', password: 'another password' }));

    expect(second).toEqual({ ok: true, value: undefined });
    expect(h.users.users.size).toBe(1);
    expect([...h.users.users.values()][0]?.passwordHash).toBe('hashed:correct horse');
    expect(h.oneTimeTokens.tokens.size).toBe(1);
    const notice = h.queued().find((email) => email.template === 'account-exists');
    expect(notice).toMatchObject({ to: 'ana@example.com', appId: h.shop.id, payload: {} });
  });

  it('hashes the password on the new-account path and on the duplicate path, so both take as long', async () => {
    const h = await accountsHarness();

    await h.signup.execute(signupInput());
    expect(h.hasher.hashCalls).toBe(1);
    await h.signup.execute(signupInput());
    expect(h.hasher.hashCalls).toBe(2);
  });

  it.each([
    ['an unknown client', { clientId: 'app_unknown' }, 'invalid_client: Unknown or inactive client'],
    ['an origin the app does not own', { origin: 'https://evil.example' }, 'invalid_client: Unknown or inactive client'],
    ['a malformed email', { email: 'not-an-email' }, 'invalid_email: Email address is not valid'],
    ['a short password', { password: '1234567' }, 'invalid_password: Password must be at least 8 characters'],
    ['a password over 72 bytes', { password: 'é'.repeat(37) }, 'invalid_password: Password must be at most 72 bytes'],
  ])('rejects %s before hashing or storing anything', async (_label, overrides, expected) => {
    const h = await accountsHarness();

    expect(failureOf(await h.signup.execute(signupInput(overrides)))).toBe(expected);

    expect(h.hasher.hashCalls).toBe(0);
    expect(h.users.users.size).toBe(0);
    expect(h.queued()).toEqual([]);
  });

  describe('email_ip limit', () => {
    const limitOne = () => accountsHarness({ policies: resolvePolicies({ email_ip: { limit: 1, windowSeconds: 600 } }) });

    it('answers rate_limited with the same error for a new and an existing email, and runs no hash', async () => {
      const h = await limitOne();
      await h.signup.execute(signupInput());
      h.clock.advanceMs(100_000);
      const queuedBefore = h.queued().length;

      const existing = await h.signup.execute(signupInput({ email: 'ana@example.com' }));
      const brandNew = await h.signup.execute(signupInput({ email: 'new@example.com' }));

      expect(existing).toEqual({ ok: false, error: expect.any(RateLimitedError) });
      expect(existing.ok ? null : (existing.error as RateLimitedError).retryAfterSeconds).toBe(500);
      expect(brandNew).toEqual(existing);
      expect(h.hasher.hashCalls).toBe(1);
      expect(h.users.users.size).toBe(1);
      expect(h.queued()).toHaveLength(queuedBefore);
    });

    it('limits per client and IP: another IP and another app still sign up', async () => {
      const h = await limitOne();
      await h.signup.execute(signupInput());

      expect((await h.signup.execute(signupInput({ ip: OTHER_IP, email: 'bo@example.com' }))).ok).toBe(true);
      expect((await h.signup.execute(signupInput({ clientId: BLOG_CLIENT_ID, email: 'cy@example.com' }))).ok).toBe(true);
      expect((await h.signup.execute(signupInput({ email: 'di@example.com' }))).ok).toBe(false);
    });

    it('counts requests from unknown clients against one shared bucket instead of a fresh counter per client_id', async () => {
      const h = await limitOne();

      const first = await h.signup.execute(signupInput({ clientId: 'app_one' }));
      const second = await h.signup.execute(signupInput({ clientId: 'app_two' }));

      expect(first.ok ? null : first.error.code).toBe('invalid_client');
      expect(second.ok ? null : second.error.code).toBe('rate_limited');
    });

    it('fails closed with TemporarilyUnavailable before any account work when the limiter store is down', async () => {
      const h = await accountsHarness();
      h.abuseStore.failWith = new Error('db down');
      const add = jest.spyOn(h.users, 'add');

      await expect(h.signup.execute(signupInput())).rejects.toBeInstanceOf(TemporarilyUnavailable);

      expect(add).not.toHaveBeenCalled();
      expect(h.hasher.hashCalls).toBe(0);
      expect(h.queued()).toEqual([]);
    });
  });

  describe('email_account cap', () => {
    it('answers normally but sends nothing past the cap, for a duplicate too, while still hashing', async () => {
      const h = await accountsHarness();
      for (let i = 0; i < 3; i += 1) await h.signup.execute(signupInput());
      expect(h.queued().map((email) => email.template)).toEqual(['confirmation', 'account-exists', 'account-exists']);

      const capped = await h.signup.execute(signupInput());

      expect(capped).toEqual({ ok: true, value: undefined });
      expect(h.queued()).toHaveLength(3);
      expect(h.hasher.hashCalls).toBe(4);
    });

    it('still creates a new account when the cap is reached, but queues no email and issues no token', async () => {
      const h = await accountsHarness({ policies: resolvePolicies({ email_account: { limit: 0 } }) });

      expect(await h.signup.execute(signupInput())).toEqual({ ok: true, value: undefined });

      expect(h.users.users.size).toBe(1);
      expect(h.queued()).toEqual([]);
      expect(h.oneTimeTokens.tokens.size).toBe(0);
      expect(h.hasher.hashCalls).toBe(1);
    });

    it('caps per client and email: another address and another app are unaffected, and the window rolls', async () => {
      const h = await accountsHarness({ policies: resolvePolicies({ email_account: { limit: 1, windowSeconds: 3600 } }) });
      await h.signup.execute(signupInput());
      await h.signup.execute(signupInput());
      expect(h.queued()).toHaveLength(1);

      await h.signup.execute(signupInput({ email: 'bo@example.com' }));
      await h.signup.execute(signupInput({ clientId: BLOG_CLIENT_ID }));
      expect(h.queued()).toHaveLength(3);

      h.clock.advanceMs(3_600_000);
      await h.signup.execute(signupInput());
      expect(h.queued()).toHaveLength(4);
    });

    it('counts the cap once per request, for a new account and a duplicate, outside the unit of work', async () => {
      // The harness store throws if it is called inside a unit of work (the real store would need a second pool
      // connection while the transaction holds the first, and deadlock under concurrency), so a green run proves it.
      const h = await accountsHarness();

      await h.signup.execute(signupInput());
      expect(h.abuseStore.hitCounts.email_account).toBe(1);
      await h.signup.execute(signupInput());
      expect(h.abuseStore.hitCounts.email_account).toBe(2);
    });

    it('does not count a request that fails validation', async () => {
      const h = await accountsHarness({ policies: resolvePolicies({ email_account: { limit: 1 } }) });
      await h.signup.execute(signupInput({ password: 'short' }));

      await h.signup.execute(signupInput());

      expect(h.queued().map((email) => email.template)).toEqual(['confirmation']);
    });
  });

  describe('unconfigured client', () => {
    const CONFIRM_URL = 'https://shop.example/confirm';
    const RESET_URL = 'https://shop.example/reset';

    it.each([
      ['no email URL', null, null],
      ['only email_confirmation_url', CONFIRM_URL, null],
      ['only password_reset_url', null, RESET_URL],
    ])('rejects an app with %s before any account work', async (_label, emailConfirmationUrl, passwordResetUrl) => {
      const h = await accountsHarness();
      const legacy = await h.addApp('app_legacy', { emailConfirmationUrl, passwordResetUrl });

      const result = await h.signup.execute(signupInput({ clientId: legacy.clientId }));

      expect(failureOf(result)).toBe('unconfigured_client: This client is not configured to send email');
      expect(h.hasher.hashCalls).toBe(0);
      expect(h.users.users.size).toBe(0);
      expect(h.queued()).toEqual([]);
      expect(h.oneTimeTokens.tokens.size).toBe(0);
    });

    it('accepts an app with both URLs', async () => {
      const h = await accountsHarness();
      const configured = await h.addApp('app_configured', { emailConfirmationUrl: CONFIRM_URL, passwordResetUrl: RESET_URL });

      expect((await h.signup.execute(signupInput({ clientId: configured.clientId }))).ok).toBe(true);
    });
  });
});
