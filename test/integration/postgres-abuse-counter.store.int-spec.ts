import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { ClientRef } from '../../src/abuse-protection/domain/client-ref';
import { CounterKey } from '../../src/abuse-protection/domain/counter-key';
import { DEFAULT_POLICIES, type Policy } from '../../src/abuse-protection/domain/policy';
import {
  AbuseCounterSchema,
  type AbuseCounterRow,
} from '../../src/abuse-protection/infrastructure/persistence/abuse-counter.schema';
import { PostgresAbuseCounterStore } from '../../src/abuse-protection/infrastructure/persistence/postgres-abuse-counter.store';
import { FixedClock } from '../../src/shared-kernel/clock';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const after = (base: Date, seconds: number): Date => new Date(base.getTime() + seconds * 1000);

const WINDOW: Policy = { limit: 3, windowSeconds: 100, blockSeconds: null };
const LOCKOUT: Policy = { limit: 3, windowSeconds: 100, blockSeconds: 500 };

describe('PostgresAbuseCounterStore (integration, ADR 36)', () => {
  let db: TestDatabase;
  let store: PostgresAbuseCounterStore;
  const key = CounterKey.of('login_account_ip', ['app', 'ana@example.com', '203.0.113.9']);

  const row = async (scope = 'login_account_ip', k = key): Promise<AbuseCounterRow | null> =>
    db.dataSource.getRepository<AbuseCounterRow>(AbuseCounterSchema).findOneBy({ scope, key: k });

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AbuseCounterSchema] });
    store = new PostgresAbuseCounterStore(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  describe('hit', () => {
    it('starts a window at the first hit and counts inside it without moving the end', async () => {
      const first = await store.hit('login_account_ip', key, WINDOW, T0);
      expect(first).toEqual({ count: 1, blockedUntil: null, windowEndsAt: after(T0, 100) });

      const second = await store.hit('login_account_ip', key, WINDOW, after(T0, 60));
      expect(second).toEqual({ count: 2, blockedUntil: null, windowEndsAt: after(T0, 100) });
    });

    it('rolls over at the exact window end, anchoring the new window at that hit', async () => {
      await store.hit('login_account_ip', key, WINDOW, T0);
      await store.hit('login_account_ip', key, WINDOW, after(T0, 99));

      const rolled = await store.hit('login_account_ip', key, WINDOW, after(T0, 100));
      expect(rolled).toEqual({ count: 1, blockedUntil: null, windowEndsAt: after(T0, 200) });
    });

    it('keeps counters of different scopes and keys apart', async () => {
      await store.hit('login_account_ip', key, WINDOW, T0);
      await store.hit('login_account_ip', key, WINDOW, T0);
      const otherScope = await store.hit('login_account', key, WINDOW, T0);
      const otherKey = await store.hit('login_account_ip', CounterKey.of('login_account_ip', ['x']), WINDOW, T0);
      expect([otherScope.count, otherKey.count]).toEqual([1, 1]);
    });

    it('never blocks a policy without a block length, even far past the limit', async () => {
      let last = await store.hit('email_ip', key, WINDOW, T0);
      for (let i = 0; i < 5; i++) last = await store.hit('email_ip', key, WINDOW, T0);
      expect(last).toMatchObject({ count: 6, blockedUntil: null });
    });

    it('blocks when the count reaches the limit, for the block length', async () => {
      await store.hit('login_account_ip', key, LOCKOUT, T0);
      const second = await store.hit('login_account_ip', key, LOCKOUT, after(T0, 1));
      expect(second.blockedUntil).toBeNull();

      const third = await store.hit('login_account_ip', key, LOCKOUT, after(T0, 2));
      expect(third).toEqual({ count: 3, blockedUntil: after(T0, 502), windowEndsAt: after(T0, 100) });
      expect((await row())?.expires_at).toEqual(after(T0, 502));
    });

    it('does not extend a block with hits made during it', async () => {
      for (let i = 0; i < 3; i++) await store.hit('login_account_ip', key, LOCKOUT, T0);

      const during = await store.hit('login_account_ip', key, LOCKOUT, after(T0, 50));
      expect(during).toMatchObject({ count: 4, blockedUntil: after(T0, 500) });
    });

    it('blocks on the first hit when the limit is 1', async () => {
      const result = await store.hit('login_account', key, { ...LOCKOUT, limit: 1 }, T0);
      expect(result.blockedUntil).toEqual(after(T0, 500));
    });

    it('keeps an active block across a window rollover and restarts the count', async () => {
      for (let i = 0; i < 3; i++) await store.hit('login_account_ip', key, LOCKOUT, T0);

      const rolled = await store.hit('login_account_ip', key, LOCKOUT, after(T0, 150));
      expect(rolled).toEqual({ count: 1, blockedUntil: after(T0, 500), windowEndsAt: after(T0, 250) });
      expect((await row())?.expires_at).toEqual(after(T0, 500));
    });

    it('restarts the window when a block expires inside it, so the lock really lifts', async () => {
      const policy: Policy = { limit: 3, windowSeconds: 1000, blockSeconds: 100 };
      for (let i = 0; i < 3; i++) await store.hit('login_account_ip', key, policy, T0);

      const next = await store.hit('login_account_ip', key, policy, after(T0, 200));
      expect(next).toEqual({ count: 1, blockedUntil: null, windowEndsAt: after(T0, 1200) });
      expect((await row())?.expires_at).toEqual(after(T0, 1200));
    });

    it('loses no update under 10 parallel hits and sets the block once', async () => {
      const policy: Policy = { limit: 10, windowSeconds: 100, blockSeconds: 500 };
      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.hit('login_account_ip', key, policy, T0)),
      );

      expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(results.filter((r) => r.blockedUntil !== null)).toHaveLength(1);
      expect(await row()).toMatchObject({ count: 10, blocked_until: after(T0, 500) });
    });

    it('keeps the count when the surrounding business transaction rolls back', async () => {
      const unitOfWork = new TypeOrmUnitOfWork(db.dataSource);

      await expect(
        unitOfWork.run(async () => {
          await store.hit('login_account_ip', key, WINDOW, T0);
          throw new Error('business failure');
        }),
      ).rejects.toThrow('business failure');

      expect((await row())?.count).toBe(1);
    });
  });

  describe('reset', () => {
    it('forgets one counter and leaves the others', async () => {
      const other = CounterKey.of('login_account_ip', ['other']);
      await store.hit('login_account_ip', key, WINDOW, T0);
      await store.hit('login_account_ip', other, WINDOW, T0);

      await store.reset('login_account_ip', key);

      expect(await row()).toBeNull();
      expect(await row('login_account_ip', other)).not.toBeNull();
      expect((await store.hit('login_account_ip', key, WINDOW, T0)).count).toBe(1);
    });

    it('is a no-op for a missing counter', async () => {
      await expect(store.reset('login_account_ip', key)).resolves.toBeUndefined();
    });
  });

  describe('deleteExpired', () => {
    const keyOf = (n: number) => CounterKey.of('email_ip', [`ip-${n}`]);
    const total = async (): Promise<number> => db.dataSource.getRepository(AbuseCounterSchema).count();

    it('deletes counters whose expiry has passed and keeps live ones, a lockout included', async () => {
      await store.hit('email_ip', keyOf(1), WINDOW, T0); // expires T0+100
      await store.hit('email_ip', keyOf(2), WINDOW, after(T0, 60)); // expires T0+160
      for (let i = 0; i < 3; i++) await store.hit('login_account_ip', key, LOCKOUT, T0); // locked until T0+500

      expect(await store.deleteExpired(after(T0, 100), 1000)).toBe(1);
      expect(await store.deleteExpired(after(T0, 400), 1000)).toBe(1);
      expect(await total()).toBe(1);
      expect((await row())?.blocked_until).toEqual(after(T0, 500));
      expect(await store.deleteExpired(after(T0, 500), 1000)).toBe(1);
      expect(await total()).toBe(0);
    });

    it('deletes at most the batch size per call', async () => {
      for (let n = 0; n < 5; n++) await store.hit('email_ip', keyOf(n), WINDOW, T0);
      const later = after(T0, 1000);

      expect(await store.deleteExpired(later, 2)).toBe(2);
      expect(await total()).toBe(3);
      expect(await store.deleteExpired(later, 2)).toBe(2);
      expect(await store.deleteExpired(later, 2)).toBe(1);
      expect(await store.deleteExpired(later, 2)).toBe(0);
    });
  });

  describe('login pre-count through the guard', () => {
    it('lets exactly the limit through when attempts for one pair race on the real table', async () => {
      const guard = new AbuseGuard({ store, policies: DEFAULT_POLICIES, clock: new FixedClock(T0) });
      const ip = ClientIp.from('203.0.113.9', undefined);

      const decisions = await Promise.all(
        Array.from({ length: 12 }, () => guard.beginLoginAttempt(ClientRef.resolved('app'), 'ana@example.com', ip)),
      );

      expect(decisions.filter((d) => d === 'allowed')).toHaveLength(DEFAULT_POLICIES.login_account_ip.limit);
    });
  });
});
