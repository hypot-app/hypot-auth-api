import { accountsHarness, SHOP_CLIENT_ID } from '../../../test/support/accounts-harness';

const INVALID = {
  ok: false,
  error: expect.objectContaining({
    code: 'invalid_or_expired_link',
    message: 'The confirmation link is invalid or has expired',
  }),
};

const signedUp = async () => {
  const h = await accountsHarness();
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'correct horse' });
  const user = [...h.users.users.values()][0]!;
  return { h, user, token: h.latestConfirmationToken() };
};

describe('ConfirmEmailUseCase', () => {
  it('confirms the account, uses the token up and queues the welcome email', async () => {
    const { h, user, token } = await signedUp();
    h.clock.advanceMs(3_600_000);

    expect(await h.confirm.execute(token)).toEqual({ ok: true, value: undefined });

    const confirmed = await h.users.findById(user.id);
    expect(confirmed?.isConfirmed()).toBe(true);
    expect(confirmed?.emailVerifiedAt).toEqual(h.clock.now());
    expect([...h.oneTimeTokens.tokens.values()][0]?.consumedAt).toEqual(h.clock.now());
    const welcome = h.queued().filter((email) => email.template === 'welcome');
    expect(welcome).toHaveLength(1);
    expect(welcome[0]).toMatchObject({ to: 'ana@example.com', appId: h.shop.id, payload: {} });
  });

  it('refuses a token that was already used and sends no second welcome', async () => {
    const { h, token } = await signedUp();
    await h.confirm.execute(token);

    expect(await h.confirm.execute(token)).toEqual(INVALID);
    expect(h.queued().filter((email) => email.template === 'welcome')).toHaveLength(1);
  });

  it('refuses an expired token and leaves the account unconfirmed', async () => {
    const { h, user, token } = await signedUp();
    h.clock.advanceMs(24 * 3_600_000);

    expect(await h.confirm.execute(token)).toEqual(INVALID);
    expect((await h.users.findById(user.id))?.isConfirmed()).toBe(false);
  });

  it.each([
    ['unknown', 'A'.repeat(43)],
    ['malformed', 'abc'],
    ['missing', undefined],
  ])('answers a %s token with the same generic error', async (_label, token) => {
    const { h } = await signedUp();
    expect(await h.confirm.execute(token)).toEqual(INVALID);
  });
});
