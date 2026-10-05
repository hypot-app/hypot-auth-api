import { accountsHarness, SHOP_CLIENT_ID, START } from '../../../test/support/accounts-harness';
import { hashToken } from '../../shared-kernel/token-generator';

const signupInput = (overrides: Partial<{ clientId: string; email: string; password: string }> = {}) => ({
  clientId: SHOP_CLIENT_ID,
  email: 'Ana@Example.com',
  password: 'correct horse',
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
});
