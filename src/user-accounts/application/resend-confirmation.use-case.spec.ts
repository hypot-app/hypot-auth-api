import { accountsHarness, BLOG_CLIENT_ID, SHOP_CLIENT_ID } from '../../../test/support/accounts-harness';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { RateLimitedError } from '../../abuse-protection/domain/rate-limited-error';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';

const OK = { ok: true, value: undefined };
const IP = ClientIp.from('203.0.113.7', undefined);
const OTHER_IP = ClientIp.from('198.51.100.9', undefined);

const resendInput = (overrides: Partial<{ clientId: string; email: string; origin: string; ip: ClientIp }> = {}) => ({
  clientId: SHOP_CLIENT_ID,
  email: 'ana@example.com',
  ip: IP,
  ...overrides,
});

const signedUp = async (policies: Parameters<typeof resolvePolicies>[0] = {}) => {
  const h = await accountsHarness({ policies: resolvePolicies(policies) });
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'correct horse', ip: IP });
  return { h, firstToken: h.latestConfirmationToken() };
};

describe('ResendConfirmationUseCase', () => {
  it('issues a new token, queues a new email and invalidates the previous token', async () => {
    const { h, firstToken } = await signedUp();
    h.clock.advanceMs(60_000);

    expect(await h.resend.execute(resendInput({ email: 'ANA@example.com' }))).toEqual(OK);

    expect(h.queued().filter((email) => email.template === 'confirmation')).toHaveLength(2);
    const secondToken = h.latestConfirmationToken();
    expect(secondToken).not.toBe(firstToken);
    expect((await h.confirm.execute({ token: firstToken, ip: h.ip })).ok).toBe(false);
    expect((await h.confirm.execute({ token: secondToken, ip: h.ip })).ok).toBe(true);
  });

  it('answers the same way and queues nothing for an unknown email', async () => {
    const { h } = await signedUp();
    const before = h.queued().length;

    expect(await h.resend.execute(resendInput({ email: 'nobody@example.com' }))).toEqual(OK);
    expect(h.queued()).toHaveLength(before);
  });

  it('answers the same way and queues nothing for an already confirmed account', async () => {
    const { h, firstToken } = await signedUp();
    await h.confirm.execute({ token: firstToken, ip: h.ip });
    const before = h.queued().length;

    expect(await h.resend.execute(resendInput())).toEqual(OK);
    expect(h.queued()).toHaveLength(before);
  });

  it.each([
    ['an unknown client', { clientId: 'app_unknown' }, 'invalid_client'],
    ['an origin the app does not own', { origin: 'https://evil.example' }, 'invalid_client'],
    ['a malformed email', { email: 'nope' }, 'invalid_email'],
  ])('rejects %s', async (_label, overrides, code) => {
    const { h } = await signedUp();
    const result = await h.resend.execute(resendInput(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });

  describe('email_ip limit', () => {
    const limitOne = () => signedUp({ email_ip: { limit: 1, windowSeconds: 600 } });

    it('answers rate_limited, identical for an unconfirmed and an unknown address, before any lookup', async () => {
      const { h } = await limitOne();
      await h.resend.execute(resendInput({ email: 'warmup@example.com' }));
      h.clock.advanceMs(100_000);
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      const queuedBefore = h.queued().length;

      const unconfirmed = await h.resend.execute(resendInput());
      const unknown = await h.resend.execute(resendInput({ email: 'nobody@example.com' }));

      expect(unconfirmed).toEqual({ ok: false, error: expect.any(RateLimitedError) });
      expect(unconfirmed.ok ? null : (unconfirmed.error as RateLimitedError).retryAfterSeconds).toBe(500);
      expect(unknown).toEqual(unconfirmed);
      expect(lookup).not.toHaveBeenCalled();
      expect(h.queued()).toHaveLength(queuedBefore);
    });

    it('limits per client and IP: another IP and another app are unaffected', async () => {
      const { h } = await limitOne();
      await h.resend.execute(resendInput());

      expect((await h.resend.execute(resendInput())).ok).toBe(false);
      expect((await h.resend.execute(resendInput({ ip: OTHER_IP }))).ok).toBe(true);
      expect((await h.resend.execute(resendInput({ clientId: BLOG_CLIENT_ID }))).ok).toBe(true);
    });

    it('fails closed with TemporarilyUnavailable before any lookup when the limiter store is down', async () => {
      const { h } = await signedUp();
      h.abuseStore.failWith = new Error('db down');
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');

      await expect(h.resend.execute(resendInput())).rejects.toBeInstanceOf(TemporarilyUnavailable);

      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('email_account cap', () => {
    it('answers normally but queues nothing and keeps the current token valid once the cap is reached', async () => {
      // The signup email already used one of the two.
      const { h, firstToken } = await signedUp({ email_account: { limit: 2 } });
      await h.resend.execute(resendInput());
      const secondToken = h.latestConfirmationToken();
      expect(h.queued().filter((email) => email.template === 'confirmation')).toHaveLength(2);

      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      const capped = await h.resend.execute(resendInput());

      expect(capped).toEqual(OK);
      expect(lookup).not.toHaveBeenCalled();
      expect(h.queued().filter((email) => email.template === 'confirmation')).toHaveLength(2);
      expect(firstToken).not.toBe(secondToken);
      expect((await h.confirm.execute({ token: secondToken, ip: h.ip })).ok).toBe(true);
    });

    it('counts a request for an unknown address too, so the cap reveals nothing about existence', async () => {
      const { h } = await signedUp({ email_account: { limit: 1 } });
      const before = h.queued().length;

      // No account yet: the request still uses up the one allowed email for this address.
      await h.resend.execute(resendInput({ email: 'ghost@example.com' }));
      await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ghost@example.com', password: 'correct horse', ip: IP });

      expect(await h.users.findByAppAndEmail(h.shop.id, 'ghost@example.com')).not.toBeNull();
      expect(h.queued()).toHaveLength(before);
    });
  });

  describe('unconfigured client', () => {
    it.each([
      ['no email URL', null, null],
      ['only email_confirmation_url', 'https://shop.example/confirm', null],
      ['only password_reset_url', null, 'https://shop.example/reset'],
    ])('rejects an app with %s before any account work', async (_label, emailConfirmationUrl, passwordResetUrl) => {
      const { h } = await signedUp();
      const legacy = await h.addApp('app_legacy', { emailConfirmationUrl, passwordResetUrl });
      const lookup = jest.spyOn(h.users, 'findByAppAndEmail');
      const before = h.queued().length;

      const result = await h.resend.execute(resendInput({ clientId: legacy.clientId }));

      expect(result.ok ? null : `${result.error.code}: ${result.error.message}`).toBe(
        'unconfigured_client: This client is not configured to send email',
      );
      expect(lookup).not.toHaveBeenCalled();
      expect(h.queued()).toHaveLength(before);
    });
  });
});
