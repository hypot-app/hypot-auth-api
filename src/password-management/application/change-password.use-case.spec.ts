import { accountsHarness, BLOG_ORIGIN, SHOP_CLIENT_ID, SHOP_ORIGIN } from '../../../test/support/accounts-harness';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../abuse-protection/domain/policy';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';

const IP = ClientIp.from('203.0.113.7', undefined);
const IP_B = ClientIp.from('198.51.100.9', undefined);
const IP_C = ClientIp.from('192.0.2.44', undefined);
const OLD = 'old passphrase';
const NEW = 'a brand new passphrase';

/** A confirmed account with two active sessions. */
const setup = async (policies: Parameters<typeof resolvePolicies>[0] = {}) => {
  const h = await accountsHarness({ policies: resolvePolicies(policies) });
  await h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'ana@example.com', password: OLD, ip: IP });
  await h.confirm.execute({ token: h.latestConfirmationToken(), ip: h.ip });
  const user = (await h.users.findByAppAndEmail(h.shop.id, 'ana@example.com'))!;
  const sessionIds = [await h.openSession(user), await h.openSession(user)];
  return { h, user, sessionIds };
};
type Ctx = Awaited<ReturnType<typeof setup>>;

const change = (
  { h, user }: Ctx,
  overrides: Partial<{ authorization: string; origin: string; currentPassword: unknown; newPassword: unknown; ip: ClientIp }> = {},
) => h.change.execute({ authorization: h.bearer(user), currentPassword: OLD, newPassword: NEW, ip: IP, ...overrides });

const passwordOf = async ({ h, user }: Ctx) => (await h.users.findById(user.id))!.passwordHash;
const lockoutHits = (h: Ctx['h']) => [h.abuseStore.hitCounts.login_account_ip ?? 0, h.abuseStore.hitCounts.login_account ?? 0];
const failureKind = (result: Awaited<ReturnType<typeof change>>) => (result.ok ? null : result.error.kind);

describe('ChangePasswordUseCase', () => {
  describe('with the correct current password', () => {
    it('replaces the hash and password_changed_at and revokes every session of the account with the reason', async () => {
      const ctx = await setup();
      ctx.h.clock.advanceMs(60_000);

      expect(await change(ctx)).toEqual({ ok: true, value: undefined });

      const stored = (await ctx.h.users.findById(ctx.user.id))!;
      expect(stored.passwordHash).toBe(`hashed:${NEW}`);
      expect(stored.passwordChangedAt).toEqual(ctx.h.clock.now());
      for (const id of ctx.sessionIds) {
        expect(ctx.h.sessions.sessions.get(id)).toMatchObject({ revokedAt: ctx.h.clock.now(), revokedReason: 'password_changed' });
      }
    });

    it('queues one password-changed notice for the account, with no password or token in the payload', async () => {
      const ctx = await setup();
      const before = ctx.h.queued().length;

      await change(ctx);

      const queued = ctx.h.queued().slice(before);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ template: 'password-changed', to: 'ana@example.com', appId: ctx.h.shop.id, status: 'pending', payload: {} });
    });

    it("touches no other account's sessions or password", async () => {
      const ctx = await setup();
      await ctx.h.signup.execute({ clientId: SHOP_CLIENT_ID, email: 'bo@example.com', password: 'bo password', ip: IP });
      const bo = (await ctx.h.users.findByAppAndEmail(ctx.h.shop.id, 'bo@example.com'))!;
      const boSession = await ctx.h.openSession(bo);

      await change(ctx);

      expect(ctx.h.sessions.sessions.get(boSession)!.revokedAt).toBeNull();
      expect((await ctx.h.users.findById(bo.id))!.passwordHash).toBe('hashed:bo password');
    });

    it('resets the pair counter only: a success gives the pair its attempts back', async () => {
      const ctx = await setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      await change(ctx, { currentPassword: 'wrong passphrase' });
      expect((await change(ctx)).ok).toBe(true);

      // Without the refund the pair would already be at 2 attempts and this one would be the 3rd.
      expect((await change(ctx, { currentPassword: NEW, newPassword: 'yet another passphrase' })).ok).toBe(true);
    });

    it('keeps the account counter after a success', async () => {
      const ctx = await setup({ login_account: { limit: 2, blockSeconds: 900 } });
      await change(ctx, { currentPassword: 'wrong passphrase', ip: IP_B });
      await change(ctx, { ip: IP_C });

      // Two attempts from other IPs already used the account's allowance of 2.
      const blocked = await change(ctx, { currentPassword: NEW, newPassword: 'yet another passphrase' });

      expect(failureKind(blocked)).toBe('invalid_current_password');
    });
  });

  describe('with a wrong current password', () => {
    it('is invalid_current_password, never unauthorized, and changes nothing, revokes nothing and queues nothing', async () => {
      const ctx = await setup();
      const before = ctx.h.queued().length;

      const result = await change(ctx, { currentPassword: 'wrong passphrase' });

      expect(failureKind(result)).toBe('invalid_current_password');
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
      for (const id of ctx.sessionIds) expect(ctx.h.sessions.sessions.get(id)!.revokedAt).toBeNull();
      expect(ctx.h.queued()).toHaveLength(before);
    });

    it('counts the attempt on both lockout counters before the password is checked', async () => {
      const ctx = await setup();
      const before = lockoutHits(ctx.h);

      await change(ctx, { currentPassword: 'wrong passphrase' });

      expect(lockoutHits(ctx.h)).toEqual([before[0]! + 1, before[1]! + 1]);
    });

    it('does not refund anything after a failure', async () => {
      const ctx = await setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      await change(ctx, { currentPassword: 'wrong passphrase' });
      await change(ctx, { currentPassword: 'wrong passphrase' });

      expect(failureKind(await change(ctx))).toBe('invalid_current_password');
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
    });
  });

  describe('lockout', () => {
    it('answers the same invalid_current_password for the CORRECT password while the pair is blocked, without bcrypt', async () => {
      const ctx = await setup({ login_account_ip: { limit: 3, blockSeconds: 900 } });
      for (let i = 0; i < 3; i += 1) await change(ctx, { currentPassword: 'wrong passphrase' });
      const verifyBefore = ctx.h.hasher.verifyCalls;

      const blocked = await change(ctx);

      expect(failureKind(blocked)).toBe('invalid_current_password');
      expect(ctx.h.hasher.verifyCalls).toBe(verifyBefore);
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
      for (const id of ctx.sessionIds) expect(ctx.h.sessions.sessions.get(id)!.revokedAt).toBeNull();
    });

    it('blocks only the pair: the same account from another IP can still change the password', async () => {
      const ctx = await setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      for (let i = 0; i < 2; i += 1) await change(ctx, { currentPassword: 'wrong passphrase' });
      expect(failureKind(await change(ctx))).toBe('invalid_current_password');

      expect((await change(ctx, { ip: IP_B })).ok).toBe(true);
    });

    it('answers the same invalid_current_password for the correct password while the account is locked, without bcrypt', async () => {
      const ctx = await setup({ login_account: { limit: 2, blockSeconds: 900 } });
      await change(ctx, { currentPassword: 'wrong passphrase', ip: IP_B });
      await change(ctx, { currentPassword: 'wrong passphrase', ip: IP_C });
      const verifyBefore = ctx.h.hasher.verifyCalls;

      const locked = await change(ctx);

      expect(failureKind(locked)).toBe('invalid_current_password');
      expect(ctx.h.hasher.verifyCalls).toBe(verifyBefore);
    });

    it('lifts the block when the lock ends', async () => {
      const ctx = await setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      for (let i = 0; i < 2; i += 1) await change(ctx, { currentPassword: 'wrong passphrase' });
      expect(failureKind(await change(ctx))).toBe('invalid_current_password');

      ctx.h.clock.advanceMs(900_000);

      expect((await change(ctx)).ok).toBe(true);
    });

    it('fails with TemporarilyUnavailable, changing nothing, when the limiter store is down', async () => {
      const ctx = await setup();
      ctx.h.abuseStore.failWith = new Error('connection refused');

      await expect(change(ctx)).rejects.toBeInstanceOf(TemporarilyUnavailable);
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
    });
  });

  describe('order of checks', () => {
    it('answers unauthorized for a missing, malformed or unknown token before looking at the body or any counter', async () => {
      const ctx = await setup();

      for (const authorization of ['', 'Bearer nonsense', 'Bearer fake:00000000-0000-4000-8000-000000000000']) {
        const result = await change(ctx, { authorization, currentPassword: 7, newPassword: 'x' });
        expect(failureKind(result)).toBe('unauthorized');
      }
      expect(lockoutHits(ctx.h)).toEqual([0, 0]);
    });

    it('answers unauthorized, with no repository call, for a token whose sub is not a UUID', async () => {
      const ctx = await setup();
      const find = jest.spyOn(ctx.h.users, 'findByIdInApp');

      const result = await change(ctx, { authorization: ctx.h.strayBearer(ctx.h.shop.id, "1'; DROP TABLE users") });

      expect(failureKind(result)).toBe('unauthorized');
      expect(find).not.toHaveBeenCalled();
    });

    it('answers unauthorized for a valid token whose account is gone or belongs to another app', async () => {
      const ctx = await setup();

      const gone = await change(ctx, { authorization: ctx.h.strayBearer(ctx.h.shop.id, '00000000-0000-4000-8000-000000000000') });
      const otherApp = await change(ctx, { authorization: ctx.h.strayBearer(ctx.h.blog.id, ctx.user.id) });

      expect(failureKind(gone)).toBe('unauthorized');
      expect(failureKind(otherApp)).toBe('unauthorized');
      expect(lockoutHits(ctx.h)).toEqual([0, 0]);
    });

    it.each([
      ['current_password missing', { currentPassword: undefined }],
      ['new_password missing', { newPassword: undefined }],
      ['current_password not a string', { currentPassword: 5 }],
      ['new_password not a string', { newPassword: ['x'] }],
    ])('answers invalid_request for %s and touches no counter', async (_label, overrides) => {
      const ctx = await setup();

      const result = await change(ctx, overrides);

      expect(failureKind(result)).toBe('invalid_request');
      expect(lockoutHits(ctx.h)).toEqual([0, 0]);
    });

    it.each([
      ['shorter than 8 characters', 'short'],
      ['longer than 72 bytes', 'x'.repeat(73)],
      ['containing NUL', 'valid pass\0word'],
    ])('answers invalid_password for a new password %s, touches no counter and runs no bcrypt', async (_label, newPassword) => {
      const ctx = await setup();
      const verifyBefore = ctx.h.hasher.verifyCalls;

      const result = await change(ctx, { newPassword });

      expect(failureKind(result)).toBe('invalid_password');
      expect(lockoutHits(ctx.h)).toEqual([0, 0]);
      expect(ctx.h.hasher.verifyCalls).toBe(verifyBefore);
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
    });

    it('checks the body shape before the new-password rules, and the rules before the lockout', async () => {
      const ctx = await setup({ login_account_ip: { limit: 1, blockSeconds: 900 } });
      await change(ctx, { currentPassword: 'wrong passphrase' });

      // The pair is blocked now, but a weak password is still reported as invalid_password.
      expect(failureKind(await change(ctx, { newPassword: 'short' }))).toBe('invalid_password');
      expect(failureKind(await change(ctx, { newPassword: 5 }))).toBe('invalid_request');
    });
  });

  describe('origin binding (ADR 38)', () => {
    it("accepts the origin of the token's app", async () => {
      const ctx = await setup();

      expect((await change(ctx, { origin: SHOP_ORIGIN })).ok).toBe(true);
    });

    it("answers unauthorized for another app's origin before any counter or change", async () => {
      const ctx = await setup();

      expect(failureKind(await change(ctx, { origin: BLOG_ORIGIN }))).toBe('unauthorized');
      expect(lockoutHits(ctx.h)).toEqual([0, 0]);
      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
    });
  });

  describe('when the password changes while the request is in flight', () => {
    const RACING = 'racing passphrase';
    /** Another request (a reset, or a change) commits a new hash after this request read the account and before it writes. */
    const raceDuringHashing = (ctx: Ctx) => {
      const hash = ctx.h.hasher.hash.bind(ctx.h.hasher);
      jest.spyOn(ctx.h.hasher, 'hash').mockImplementationOnce(async (plain) => {
        await ctx.h.users.updatePassword(ctx.user.id, `hashed:${RACING}`, ctx.h.clock.now());
        return hash(plain);
      });
    };

    it('answers invalid_current_password, keeps the concurrent hash and revokes and queues nothing', async () => {
      const ctx = await setup();
      const before = ctx.h.queued().length;
      raceDuringHashing(ctx);

      expect(failureKind(await change(ctx))).toBe('invalid_current_password');

      expect(await passwordOf(ctx)).toBe(`hashed:${RACING}`);
      expect(ctx.h.queued()).toHaveLength(before);
      for (const id of ctx.sessionIds) expect(ctx.h.sessions.sessions.get(id)!.revokedAt).toBeNull();
    });

    it('does not count as a wrong guess: the caller proved the password they read, so the pair counter is refunded', async () => {
      const ctx = await setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      raceDuringHashing(ctx);
      await change(ctx);

      // Without the refund the miss plus this wrong guess would hit the limit of 2 and lock the pair out.
      expect(failureKind(await change(ctx, { currentPassword: 'wrong passphrase' }))).toBe('invalid_current_password');
      expect((await change(ctx, { currentPassword: RACING })).ok).toBe(true);
    });
  });

  describe('atomicity', () => {
    it('rolls the password back and queues no notice when revoking the sessions fails', async () => {
      const ctx = await setup();
      const failing = ctx.h.buildChange({
        execute: async () => {
          throw new Error('revocation failed');
        },
      });
      const before = ctx.h.queued().length;

      await expect(
        failing.execute({ authorization: ctx.h.bearer(ctx.user), currentPassword: OLD, newPassword: NEW, ip: IP }),
      ).rejects.toThrow('revocation failed');

      expect(await passwordOf(ctx)).toBe(`hashed:${OLD}`);
      expect(ctx.h.queued()).toHaveLength(before);
      for (const id of ctx.sessionIds) expect(ctx.h.sessions.sessions.get(id)!.revokedAt).toBeNull();
    });
  });
});
