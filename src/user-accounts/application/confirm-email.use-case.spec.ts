import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';
import { accountsHarness, BLOG_ORIGIN, SHOP_CLIENT_ID, SHOP_ORIGIN, type AccountsHarnessOptions } from '../../../test/support/accounts-harness';

const invalid = (clientBound: boolean) => ({ ok: false, error: { kind: 'invalid_link', clientBound } });

const signedUp = async (options?: AccountsHarnessOptions) => {
  const h = await accountsHarness(options);
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'correct horse' });
  const user = [...h.users.users.values()][0]!;
  const token = h.latestConfirmationToken();
  const confirm = (input: { token?: unknown; origin?: string } = {}) =>
    h.confirm.execute({ token: 'token' in input ? input.token : token, origin: input.origin, ip: h.ip });
  const consumedAt = () => [...h.oneTimeTokens.tokens.values()][0]?.consumedAt;
  return { h, user, token, confirm, consumedAt };
};

describe('ConfirmEmailUseCase', () => {
  it('confirms the account, uses the token up and queues the welcome email', async () => {
    const { h, user, confirm, consumedAt } = await signedUp();
    h.clock.advanceMs(3_600_000);

    expect(await confirm()).toEqual({ ok: true, value: undefined });

    const confirmed = await h.users.findById(user.id);
    expect(confirmed?.isConfirmed()).toBe(true);
    expect(confirmed?.emailVerifiedAt).toEqual(h.clock.now());
    expect(consumedAt()).toEqual(h.clock.now());
    const welcome = h.queued().filter((email) => email.template === 'welcome');
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ to: 'ana@example.com', appId: h.shop.id, payload: {} });
  });

  it('refuses a token that was already used and sends no second welcome', async () => {
    const { h, confirm } = await signedUp();
    await confirm();

    expect(await confirm()).toEqual(invalid(false));
    expect(h.queued().filter((email) => email.template === 'welcome')).toHaveLength(1);
  });

  it('refuses an expired token and leaves the account unconfirmed', async () => {
    const { h, user, confirm } = await signedUp();
    h.clock.advanceMs(24 * 3_600_000);

    expect(await confirm()).toEqual(invalid(false));
    expect((await h.users.findById(user.id))?.isConfirmed()).toBe(false);
  });

  it.each([
    ['unknown', 'A'.repeat(43)],
    ['malformed', 'abc'],
    ['missing', undefined],
    ['not a string', { $ne: '' }],
  ])('answers a %s token with the same generic error', async (_label, token) => {
    const { confirm } = await signedUp();
    expect(await confirm({ token })).toEqual(invalid(false));
  });

  describe('origin binding (ADR 38)', () => {
    it("confirms from the token's own app origin and reports the client as bound on a later failure", async () => {
      const { confirm } = await signedUp();

      expect(await confirm({ origin: SHOP_ORIGIN })).toEqual({ ok: true, value: undefined });
      expect(await confirm({ origin: SHOP_ORIGIN })).toEqual(invalid(true));
    });

    it.each([
      ['another active app', BLOG_ORIGIN],
      ['an origin no app owns', 'https://evil.example'],
      ['a different case', 'https://SHOP.example'],
    ])('refuses a valid token sent from %s, and the token stays unused', async (_label, origin) => {
      const { h, user, confirm, consumedAt } = await signedUp();

      expect(await confirm({ origin })).toEqual(invalid(false));

      expect(consumedAt()).toBeNull();
      expect((await h.users.findById(user.id))?.isConfirmed()).toBe(false);
      expect(h.queued().filter((email) => email.template === 'welcome')).toEqual([]);
      expect(await confirm()).toEqual({ ok: true, value: undefined });
    });

    it('answers an unknown token from a real app origin exactly like a wrong origin', async () => {
      const { confirm } = await signedUp();

      expect(await confirm({ token: 'A'.repeat(43), origin: SHOP_ORIGIN })).toEqual(invalid(false));
    });

    it('refuses the token of a deactivated app', async () => {
      const { h, confirm, consumedAt } = await signedUp();
      await h.apps.save(h.shop.deactivate(h.clock.now()));

      expect(await confirm({ origin: SHOP_ORIGIN })).toEqual(invalid(false));
      expect(consumedAt()).toBeNull();
    });
  });

  describe('confirm_ip limit', () => {
    const limited = () => ({ ok: false, error: { kind: 'rate_limited', retryAfterSeconds: expect.any(Number) } });

    it('answers rate_limited with an integer retry-after before any token lookup, whatever the token', async () => {
      const { h, token, confirm } = await signedUp({ policies: resolvePolicies({ confirm_ip: { limit: 2, windowSeconds: 600 } }) });
      expect(await confirm({ token: 'A'.repeat(43) })).toEqual(invalid(false));
      expect(await confirm({ token: 'abc' })).toEqual(invalid(false));
      const lookup = jest.spyOn(h.oneTimeTokens, 'findAppByTokenHash');
      const consume = jest.spyOn(h.oneTimeTokens, 'consumeByHash');

      h.clock.advanceMs(100_000);
      const valid = await confirm({ token, origin: SHOP_ORIGIN });
      const unknown = await confirm({ token: 'B'.repeat(43), origin: SHOP_ORIGIN });

      expect(valid).toEqual(limited());
      expect(valid).toEqual({ ok: false, error: { kind: 'rate_limited', retryAfterSeconds: 500 } });
      expect(unknown).toEqual(valid);
      expect(lookup).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect([...h.oneTimeTokens.tokens.values()][0]?.consumedAt).toBeNull();
    });

    it('lets requests through again once the window rolls', async () => {
      const { h, confirm } = await signedUp({ policies: resolvePolicies({ confirm_ip: { limit: 1, windowSeconds: 600 } }) });
      await confirm({ token: 'A'.repeat(43) });
      expect(await confirm()).toEqual(limited());

      h.clock.advanceMs(600_000);

      expect(await confirm()).toEqual({ ok: true, value: undefined });
    });

    it('fails closed with TemporarilyUnavailable and touches no token when the limiter store is down', async () => {
      const { h, confirm } = await signedUp();
      const lookup = jest.spyOn(h.oneTimeTokens, 'findAppByTokenHash');
      h.abuseStore.failWith = new Error('db down');

      await expect(confirm({ origin: SHOP_ORIGIN })).rejects.toBeInstanceOf(TemporarilyUnavailable);

      expect(lookup).not.toHaveBeenCalled();
      expect([...h.oneTimeTokens.tokens.values()][0]?.consumedAt).toBeNull();
    });
  });
});
