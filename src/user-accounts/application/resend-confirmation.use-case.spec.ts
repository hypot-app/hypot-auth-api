import { accountsHarness, SHOP_CLIENT_ID } from '../../../test/support/accounts-harness';

const OK = { ok: true, value: undefined };

const signedUp = async () => {
  const h = await accountsHarness();
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'correct horse' });
  return { h, firstToken: h.latestConfirmationToken() };
};

describe('ResendConfirmationUseCase', () => {
  it('issues a new token, queues a new email and invalidates the previous token', async () => {
    const { h, firstToken } = await signedUp();
    h.clock.advanceMs(60_000);

    expect(await h.resend.execute({ clientId: SHOP_CLIENT_ID, email: 'ANA@example.com' })).toEqual(OK);

    expect(h.queued().filter((email) => email.template === 'confirmation')).toHaveLength(2);
    const secondToken = h.latestConfirmationToken();
    expect(secondToken).not.toBe(firstToken);
    expect((await h.confirm.execute(firstToken)).ok).toBe(false);
    expect((await h.confirm.execute(secondToken)).ok).toBe(true);
  });

  it('answers the same way and queues nothing for an unknown email', async () => {
    const { h } = await signedUp();
    const before = h.queued().length;

    expect(await h.resend.execute({ clientId: SHOP_CLIENT_ID, email: 'nobody@example.com' })).toEqual(OK);
    expect(h.queued()).toHaveLength(before);
  });

  it('answers the same way and queues nothing for an already confirmed account', async () => {
    const { h, firstToken } = await signedUp();
    await h.confirm.execute(firstToken);
    const before = h.queued().length;

    expect(await h.resend.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com' })).toEqual(OK);
    expect(h.queued()).toHaveLength(before);
  });

  it.each([
    ['an unknown client', { clientId: 'app_unknown', email: 'ana@example.com' }, 'invalid_client'],
    ['an origin the app does not own', { clientId: SHOP_CLIENT_ID, email: 'ana@example.com', origin: 'https://evil.example' }, 'invalid_client'],
    ['a malformed email', { clientId: SHOP_CLIENT_ID, email: 'nope' }, 'invalid_email'],
  ])('rejects %s', async (_label, input, code) => {
    const { h } = await signedUp();
    const result = await h.resend.execute(input);
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});
