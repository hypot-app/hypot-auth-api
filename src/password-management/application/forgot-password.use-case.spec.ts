import { accountsHarness, BLOG_CLIENT_ID, SHOP_CLIENT_ID } from '../../../test/support/accounts-harness';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { RateLimitedError } from '../../abuse-protection/domain/rate-limited-error';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';
import { hashToken } from '../../shared-kernel/token-generator';

const OK = { ok: true, value: undefined };
const IP = ClientIp.from('203.0.113.7', undefined);
const OTHER_IP = ClientIp.from('198.51.100.9', undefined);
const HOUR_MS = 3_600_000;

const forgotInput = (overrides: Partial<{ clientId: string; email: string; origin: string; ip: ClientIp }> = {}) => ({
  clientId: SHOP_CLIENT_ID,
  email: 'ana@example.com',
  ip: IP,
  ...overrides,
});

const setup = async (policies: Parameters<typeof resolvePolicies>[0] = {}) => {
  const h = await accountsHarness({ policies: resolvePolicies(policies) });
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'correct horse', ip: IP });
  const firstConfirmation = h.latestConfirmationToken();
  return { h, firstConfirmation };
};

const confirmed = async (policies: Parameters<typeof resolvePolicies>[0] = {}) => {
  const ctx = await setup(policies);
  await ctx.h.confirm.execute({ token: ctx.firstConfirmation, ip: ctx.h.ip });
  return ctx;
};

const templates = (h: Awaited<ReturnType<typeof setup>>['h']) => h.queued().map((email) => email.template);

describe('ForgotPasswordUseCase', () => {
  describe('a confirmed account', () => {
    it('queues one password-reset email whose token is stored only as a hash, valid for 1 hour', async () => {
      const { h } = await confirmed();
      const before = h.queued().length;

      expect(await h.forgot.execute(forgotInput({ email: 'ANA@example.com' }))).toEqual(OK);

      const queued = h.queued().slice(before);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ template: 'password-reset', to: 'ana@example.com', appId: h.shop.id, status: 'pending' });
      expect(Object.keys(queued[0]!.payload)).toEqual(['token']);
      const stored = [...h.oneTimeTokens.tokens.values()].filter((t) => t.purpose === 'password_reset');
      expect(stored).toHaveLength(1);
      expect(stored[0]!.tokenHash.equals(hashToken(queued[0]!.payload['token']!))).toBe(true);
      expect(stored[0]!.expiresAt.getTime()).toBe(h.clock.now().getTime() + HOUR_MS);
      expect(JSON.stringify(stored[0])).not.toContain(queued[0]!.payload['token']!);
    });

    it('invalidates the earlier unused reset tokens, so only the newest works', async () => {
      const { h } = await confirmed();
      await h.forgot.execute(forgotInput());
      const first = h.latestResetToken();
      await h.forgot.execute(forgotInput());
      const second = h.latestResetToken();

      expect(second).not.toBe(first);
      const live = [...h.oneTimeTokens.tokens.values()].filter((t) => t.purpose === 'password_reset' && t.consumedAt === null);
      expect(live.map((t) => t.tokenHash.toString('hex'))).toEqual([hashToken(second).toString('hex')]);
    });
  });

  describe('an unconfirmed account', () => {
    it('queues a confirmation email instead of a reset, and never creates a reset token', async () => {
      const { h } = await setup();
      const before = h.queued().length;

      expect(await h.forgot.execute(forgotInput())).toEqual(OK);

      expect(templates(h).slice(before)).toEqual(['confirmation']);
      expect([...h.oneTimeTokens.tokens.values()].some((t) => t.purpose === 'password_reset')).toBe(false);
    });

    it('supersedes the earlier unused confirmation token, and the new one confirms the account', async () => {
      const { h, firstConfirmation } = await setup();
      await h.forgot.execute(forgotInput());
      const second = h.latestConfirmationToken();

      expect(second).not.toBe(firstConfirmation);
      expect((await h.confirm.execute({ token: firstConfirmation, ip: h.ip })).ok).toBe(false);
      expect((await h.confirm.execute({ token: second, ip: h.ip })).ok).toBe(true);
    });
  });

  describe('an address that has no account in the app', () => {
    it('answers the same and queues nothing for an unknown address', async () => {
      const { h } = await confirmed();
      const before = h.queued().length;

      expect(await h.forgot.execute(forgotInput({ email: 'nobody@example.com' }))).toEqual(OK);

      expect(h.queued()).toHaveLength(before);
    });

    it('answers the same and queues nothing for an address that exists only in another app', async () => {
      const { h } = await confirmed();
      const before = h.queued().length;
      const tokensBefore = h.oneTimeTokens.tokens.size;

      expect(await h.forgot.execute(forgotInput({ clientId: BLOG_CLIENT_ID }))).toEqual(OK);

      expect(h.queued()).toHaveLength(before);
      expect(h.oneTimeTokens.tokens.size).toBe(tokensBefore);
    });
  });

  describe('client checks and the IP limit', () => {
    it('rejects an unknown client with invalid_client and queues nothing', async () => {
      const { h } = await confirmed();
      const before = h.queued().length;

      const result = await h.forgot.execute(forgotInput({ clientId: 'app_missing' }));

      expect(result.ok ? null : result.error.code).toBe('invalid_client');
      expect(h.queued()).toHaveLength(before);
    });

    it('rejects an origin that is not bound to the client with invalid_client', async () => {
      const { h } = await confirmed();

      const result = await h.forgot.execute(forgotInput({ origin: 'https://blog.example' }));

      expect(result.ok ? null : result.error.code).toBe('invalid_client');
    });

    it('accepts an origin bound to the client', async () => {
      const { h } = await confirmed();

      expect(await h.forgot.execute(forgotInput({ origin: 'https://shop.example' }))).toEqual(OK);
    });

    it.each([
      ['no email URL', null, null],
      ['only email_confirmation_url', 'https://shop.example/confirm', null],
      ['only password_reset_url', null, 'https://shop.example/reset'],
    ])('rejects an app with %s with unconfigured_client before any account work', async (_label, emailConfirmationUrl, passwordResetUrl) => {
      const { h } = await confirmed();
      const legacy = await h.addApp('app_legacy', { emailConfirmationUrl, passwordResetUrl });
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      const before = h.queued().length;

      const result = await h.forgot.execute(forgotInput({ clientId: legacy.clientId }));

      expect(result.ok ? null : `${result.error.code}: ${result.error.message}`).toBe(
        'unconfigured_client: This client is not configured to send email',
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(h.queued()).toHaveLength(before);
    });

    it('limits per client and IP with a RateLimitedError, identical for a known and an unknown address, before any lookup', async () => {
      const { h } = await confirmed({ email_ip: { limit: 3 } });
      // The signup used 1 of the 3.
      await h.forgot.execute(forgotInput());
      await h.forgot.execute(forgotInput({ email: 'nobody@example.com' }));
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      const before = h.queued().length;

      const known = await h.forgot.execute(forgotInput());
      const unknown = await h.forgot.execute(forgotInput({ email: 'nobody@example.com' }));

      for (const result of [known, unknown]) {
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toBeInstanceOf(RateLimitedError);
      }
      expect(!known.ok && (known.error as RateLimitedError).retryAfterSeconds).toBe(
        !unknown.ok && (unknown.error as RateLimitedError).retryAfterSeconds,
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(h.queued()).toHaveLength(before);
    });

    it('shares the email_ip counter with signup and resend, and another IP is unaffected', async () => {
      const { h } = await confirmed({ email_ip: { limit: 2 } });
      await h.resend.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', ip: IP });

      expect((await h.forgot.execute(forgotInput())).ok).toBe(false);
      expect((await h.forgot.execute(forgotInput({ ip: OTHER_IP }))).ok).toBe(true);
    });

    it('fails with TemporarilyUnavailable before any lookup when the limiter store is down', async () => {
      const { h } = await confirmed();
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      h.abuseStore.failWith = new Error('connection refused');

      await expect(h.forgot.execute(forgotInput())).rejects.toBeInstanceOf(TemporarilyUnavailable);
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('input', () => {
    it('rejects an invalid email address and counts nothing', async () => {
      const { h } = await confirmed();
      const hitsBefore = h.abuseStore.hitCounts.email_account ?? 0;

      const result = await h.forgot.execute(forgotInput({ email: 'not-an-email' }));

      expect(result.ok ? null : result.error.code).toBe('invalid_email');
      expect(h.abuseStore.hitCounts.email_account ?? 0).toBe(hitsBefore);
    });
  });

  describe('email_account cap', () => {
    it('counts the emails of signup, resend and forgot together, and the fourth is suppressed', async () => {
      const { h } = await setup();
      await h.resend.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', ip: IP });
      await h.forgot.execute(forgotInput());
      expect(templates(h)).toEqual(['confirmation', 'confirmation', 'confirmation']);

      expect(await h.forgot.execute(forgotInput())).toEqual(OK);

      expect(templates(h)).toHaveLength(3);
    });

    it('counts a confirmation sent for an unconfirmed account like any other email', async () => {
      const { h } = await setup({ email_account: { limit: 2 } });
      await h.forgot.execute(forgotInput());

      // Signup used one and the unconfirmed forgot used the second.
      await h.forgot.execute(forgotInput());

      expect(templates(h)).toEqual(['confirmation', 'confirmation']);
    });

    it('counts a reset email for a confirmed account, and past the cap keeps the latest token valid', async () => {
      const { h } = await confirmed({ email_account: { limit: 3 } });
      await h.forgot.execute(forgotInput());
      await h.forgot.execute(forgotInput());
      const latest = h.latestResetToken();

      expect(await h.forgot.execute(forgotInput())).toEqual(OK);

      expect(templates(h).filter((template) => template === 'password-reset')).toHaveLength(2);
      expect(h.latestResetToken()).toBe(latest);
      const live = [...h.oneTimeTokens.tokens.values()].filter((t) => t.purpose === 'password_reset' && t.consumedAt === null);
      expect(live.map((t) => t.tokenHash.toString('hex'))).toEqual([hashToken(latest).toString('hex')]);
    });

    it('does not count a forgot for an unknown address', async () => {
      const { h } = await confirmed();
      const hitsBefore = h.abuseStore.hitCounts.email_account ?? 0;

      for (let i = 0; i < 5; i += 1) await h.forgot.execute(forgotInput({ email: 'nobody@example.com' }));

      expect(h.abuseStore.hitCounts.email_account ?? 0).toBe(hitsBefore);
    });

    it('does not count a forgot for an address that exists only in another app', async () => {
      const { h } = await confirmed();
      const hitsBefore = h.abuseStore.hitCounts.email_account ?? 0;

      await h.forgot.execute(forgotInput({ clientId: BLOG_CLIENT_ID }));

      expect(h.abuseStore.hitCounts.email_account ?? 0).toBe(hitsBefore);
    });
  });
});
