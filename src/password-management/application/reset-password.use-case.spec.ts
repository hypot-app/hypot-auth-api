import { accountsHarness, BLOG_ORIGIN, SHOP_CLIENT_ID, SHOP_ORIGIN } from '../../../test/support/accounts-harness';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';
import { hashToken } from '../../shared-kernel/token-generator';

const IP = ClientIp.from('203.0.113.7', undefined);
const OTHER_IP = ClientIp.from('198.51.100.9', undefined);
const HOUR_MS = 3_600_000;
const NEW_PASSWORD = 'a brand new passphrase';

/** A confirmed account with two active sessions that asked for a reset. */
const setup = async (policies: Parameters<typeof resolvePolicies>[0] = {}) => {
  const h = await accountsHarness({ policies: resolvePolicies(policies) });
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'old password', ip: IP });
  await h.confirm.execute({ token: h.latestConfirmationToken(), ip: h.ip });
  const user = (await h.users.findByAppAndEmail(h.shop.id, 'ana@example.com'))!;
  const sessionIds = [await h.openSession(user), await h.openSession(user)];
  await h.forgot.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', ip: OTHER_IP });
  return { h, user, sessionIds, token: h.latestResetToken() };
};

const submit = (
  h: Awaited<ReturnType<typeof setup>>['h'],
  token: unknown,
  overrides: Partial<{ newPassword: string; origin: string; ip: ClientIp }> = {},
) => h.reset.execute({ token, newPassword: NEW_PASSWORD, ip: IP, ...overrides });

const passwordOf = async (h: Awaited<ReturnType<typeof setup>>['h'], id: string) => (await h.users.findById(id))!.passwordHash;

describe('ResetPasswordUseCase', () => {
  describe('a valid token', () => {
    it('replaces the hash and password_changed_at, marks the token used and revokes every session with the reason', async () => {
      const { h, user, sessionIds, token } = await setup();
      h.clock.advanceMs(60_000);

      expect(await submit(h, token)).toEqual({ ok: true, value: undefined });

      const stored = (await h.users.findById(user.id))!;
      expect(stored.passwordHash).toBe(`hashed:${NEW_PASSWORD}`);
      expect(stored.passwordChangedAt).toEqual(h.clock.now());
      const tokenRow = [...h.oneTimeTokens.tokens.values()].find((t) => t.tokenHash.equals(hashToken(token)))!;
      expect(tokenRow.consumedAt).toEqual(h.clock.now());
      for (const id of sessionIds) {
        expect(h.sessions.sessions.get(id)).toMatchObject({ revokedAt: h.clock.now(), revokedReason: 'password_reset' });
      }
    });

    it("touches no other account's password or sessions", async () => {
      const { h, token } = await setup();
      await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'bo@example.com', password: 'bo password', ip: IP });
      const bo = (await h.users.findByAppAndEmail(h.shop.id, 'bo@example.com'))!;
      const boSession = await h.openSession(bo);

      await submit(h, token);

      expect(await passwordOf(h, bo.id)).toBe('hashed:bo password');
      expect(h.sessions.sessions.get(boSession)!.revokedAt).toBeNull();
    });

    it('does not log the user in: it issues no session', async () => {
      const { h, token } = await setup();
      const before = h.sessions.tokenCount();

      await submit(h, token);

      expect(h.sessions.tokenCount()).toBe(before);
    });
  });

  describe('a token that cannot be used', () => {
    const expectGenericFailure = (result: Awaited<ReturnType<typeof submit>>, clientBound = false) =>
      expect(result).toEqual({ ok: false, error: { kind: 'invalid_link', clientBound } });

    it('fails a used token the second time and keeps the first password', async () => {
      const { h, user, token } = await setup();
      await submit(h, token);

      expectGenericFailure(await submit(h, token, { newPassword: 'another passphrase' }));

      expect(await passwordOf(h, user.id)).toBe(`hashed:${NEW_PASSWORD}`);
    });

    it('fails a token older than 1 hour', async () => {
      const { h, user, token } = await setup();
      h.clock.advanceMs(HOUR_MS);

      expectGenericFailure(await submit(h, token));

      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
    });

    it('accepts a token just under 1 hour old', async () => {
      const { h, token } = await setup();
      h.clock.advanceMs(HOUR_MS - 1);

      expect((await submit(h, token)).ok).toBe(true);
    });

    it('fails the first of two issued tokens (superseded) and accepts the second', async () => {
      const { h, user, token: first } = await setup();
      await h.forgot.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', ip: OTHER_IP });
      const second = h.latestResetToken();

      expectGenericFailure(await submit(h, first));
      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
      expect((await submit(h, second)).ok).toBe(true);
    });

    it.each([
      ['unknown', 'x'.repeat(43)],
      ['malformed', 'not a token!'],
      ['empty', ''],
      ['not a string', 42],
      ['null', null],
    ])('fails an %s token', async (_label, value) => {
      const { h, user } = await setup();

      expectGenericFailure(await submit(h, value));

      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
    });

    it('fails an email-confirmation token used as a reset token', async () => {
      const h = await accountsHarness();
      await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: 'old password', ip: IP });

      expectGenericFailure(await submit(h, h.latestConfirmationToken()));

      // The confirmation token is still good for confirming.
      expect((await h.confirm.execute({ token: h.latestConfirmationToken(), ip: h.ip })).ok).toBe(true);
    });
  });

  describe('the new password', () => {
    it.each([
      ['shorter than 8 characters', 'short'],
      ['longer than 72 bytes', 'x'.repeat(73)],
      ['containing NUL', 'valid pass\0word'],
    ])('rejects a password %s with invalid_password, keeps the token usable and touches no counter', async (_label, newPassword) => {
      const { h, user, token } = await setup();
      const hitsBefore = h.abuseStore.hitCounts.reset_ip ?? 0;

      const weak = await submit(h, token, { newPassword });

      expect(weak.ok ? null : weak.error).toMatchObject({ kind: 'invalid_password', error: { code: 'invalid_password' } });
      expect(h.abuseStore.hitCounts.reset_ip ?? 0).toBe(hitsBefore);
      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
      expect((await submit(h, token)).ok).toBe(true);
    });

    it('answers a weak password the same way for a valid and an invalid token', async () => {
      const { h, token } = await setup();

      const valid = await submit(h, token, { newPassword: 'short' });
      const invalid = await submit(h, 'y'.repeat(43), { newPassword: 'short' });

      expect(invalid).toEqual(valid);
    });

    it('does not run bcrypt for a token that does not exist, so garbage tokens cost no CPU beyond the IP limit', async () => {
      const { h } = await setup();
      const before = h.hasher.hashCalls;

      await submit(h, 'g'.repeat(43));
      await submit(h, 'g'.repeat(43), { origin: SHOP_ORIGIN });

      expect(h.hasher.hashCalls).toBe(before);
    });

    it('hashes the new password exactly once', async () => {
      const { h, token } = await setup();
      const before = h.hasher.hashCalls;

      await submit(h, token);

      expect(h.hasher.hashCalls).toBe(before + 1);
    });
  });

  describe('reset_ip limit', () => {
    it('answers rate_limited, identical for a valid and an invalid token, before any token lookup, leaving the token usable', async () => {
      const { h, user, token } = await setup({ reset_ip: { limit: 1 } });
      await submit(h, 'z'.repeat(43), { ip: OTHER_IP });
      const find = jest.spyOn(h.oneTimeTokens, 'findAppByTokenHash');
      const consume = jest.spyOn(h.oneTimeTokens, 'consumeByHash');

      const valid = await submit(h, token, { ip: OTHER_IP });
      const invalid = await submit(h, 'z'.repeat(43), { ip: OTHER_IP, origin: SHOP_ORIGIN });

      expect(valid.ok ? null : valid.error).toMatchObject({ kind: 'rate_limited' });
      expect(invalid).toEqual(valid);
      expect(find).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
      expect((await submit(h, token)).ok).toBe(true);
    });

    it('limits per IP alone: another IP is unaffected', async () => {
      const { h, token } = await setup({ reset_ip: { limit: 1 } });
      await submit(h, 'z'.repeat(43), { ip: OTHER_IP });

      expect((await submit(h, token, { ip: IP })).ok).toBe(true);
    });

    it('fails with TemporarilyUnavailable before any lookup when the limiter store is down', async () => {
      const { h, token } = await setup();
      const find = jest.spyOn(h.oneTimeTokens, 'findAppByTokenHash');
      h.abuseStore.failWith = new Error('connection refused');

      await expect(submit(h, token, { origin: SHOP_ORIGIN })).rejects.toBeInstanceOf(TemporarilyUnavailable);
      expect(find).not.toHaveBeenCalled();
    });
  });

  describe('origin binding (ADR 38)', () => {
    it("accepts the origin of the token's app and reports the client as bound on a later failure", async () => {
      const { h, token } = await setup();

      expect((await submit(h, token, { origin: SHOP_ORIGIN })).ok).toBe(true);
      expect(await submit(h, token, { origin: SHOP_ORIGIN })).toEqual({ ok: false, error: { kind: 'invalid_link', clientBound: true } });
    });

    it("refuses another app's origin with the generic failure, unbound, and leaves the token unused", async () => {
      const { h, user, token } = await setup();
      const consume = jest.spyOn(h.oneTimeTokens, 'consumeByHash');

      const result = await submit(h, token, { origin: BLOG_ORIGIN });

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_link', clientBound: false } });
      expect(consume).not.toHaveBeenCalled();
      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
      expect((await submit(h, token)).ok).toBe(true);
    });

    it('treats an unknown token with an origin as unbound', async () => {
      const { h } = await setup();

      expect(await submit(h, 'q'.repeat(43), { origin: SHOP_ORIGIN })).toEqual({ ok: false, error: { kind: 'invalid_link', clientBound: false } });
    });

    it('lets a request with no Origin through (a backend caller)', async () => {
      const { h, token } = await setup();

      expect((await submit(h, token)).ok).toBe(true);
    });
  });

  describe('atomicity', () => {
    it('rolls the password and the token back when revoking the sessions fails', async () => {
      const { h, user, sessionIds, token } = await setup();
      const failing = h.buildReset({
        execute: async () => {
          throw new Error('revocation failed');
        },
      });

      await expect(failing.execute({ token, newPassword: NEW_PASSWORD, ip: IP })).rejects.toThrow('revocation failed');

      expect(await passwordOf(h, user.id)).toBe('hashed:old password');
      for (const id of sessionIds) expect(h.sessions.sessions.get(id)!.revokedAt).toBeNull();
      expect((await submit(h, token)).ok).toBe(true);
    });
  });
});
