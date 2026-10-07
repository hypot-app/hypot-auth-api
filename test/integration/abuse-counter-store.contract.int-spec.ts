import type { AbuseCounterStore } from '../../src/abuse-protection/domain/abuse-counter.store';
import { CounterKey } from '../../src/abuse-protection/domain/counter-key';
import type { Policy } from '../../src/abuse-protection/domain/policy';
import { AbuseCounterSchema } from '../../src/abuse-protection/infrastructure/persistence/abuse-counter.schema';
import { PostgresAbuseCounterStore } from '../../src/abuse-protection/infrastructure/persistence/postgres-abuse-counter.store';
import { InMemoryAbuseCounterStore } from '../support/in-memory-abuse-counter-store';
import { startTestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const after = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);
const KEY = CounterKey.of('login_account_ip', ['app', 'ana@example.com', '203.0.113.9']);
const OTHER = CounterKey.of('login_account_ip', ['app', 'bob@example.com', '203.0.113.9']);
const WINDOW: Policy = { limit: 3, windowSeconds: 100, blockSeconds: null };
const LOCKOUT: Policy = { limit: 3, windowSeconds: 100, blockSeconds: 500 };

interface Variant {
  name: string;
  start(): Promise<{ fresh(): Promise<AbuseCounterStore>; stop(): Promise<void> }>;
}

// The in-memory fake stands in for the real store in guard tests, so both must obey the same rules.
const variants: Variant[] = [
  {
    name: 'InMemoryAbuseCounterStore',
    start: async () => ({ fresh: async () => new InMemoryAbuseCounterStore(), stop: async () => undefined }),
  },
  {
    name: 'PostgresAbuseCounterStore',
    start: async () => {
      const db = await startTestDatabase({ entities: [AbuseCounterSchema] });
      const store = new PostgresAbuseCounterStore(db.dataSource);
      return {
        fresh: async () => {
          await db.truncate();
          return store;
        },
        stop: () => db.teardown(),
      };
    },
  },
];

describe.each(variants)('AbuseCounterStore contract: $name', ({ start }) => {
  let stop: () => Promise<void>;
  let fresh: () => Promise<AbuseCounterStore>;
  let store: AbuseCounterStore;

  beforeAll(async () => {
    ({ fresh, stop } = await start());
  }, 180_000);
  afterAll(async () => stop?.(), 60_000);
  beforeEach(async () => {
    store = await fresh();
  });

  const hits = async (times: number, policy: Policy, at = T0, key = KEY) => {
    let last = await store.hit('login_account_ip', key, policy, at);
    for (let i = 1; i < times; i++) last = await store.hit('login_account_ip', key, policy, at);
    return last;
  };

  it('counts inside a window anchored at the first hit, then rolls over at its exact end', async () => {
    expect(await hits(1, WINDOW)).toEqual({ count: 1, blockedUntil: null, windowEndsAt: after(100), blockedBefore: false });
    expect(await store.hit('login_account_ip', KEY, WINDOW, after(60))).toMatchObject({ count: 2, windowEndsAt: after(100) });
    expect(await store.hit('login_account_ip', KEY, WINDOW, after(100))).toEqual({
      count: 1,
      blockedUntil: null,
      windowEndsAt: after(200),
      blockedBefore: false,
    });
  });

  it('never blocks a policy without a block length, and blocks at the limit when it has one', async () => {
    expect((await hits(9, WINDOW)).blockedUntil).toBeNull();
    store = await fresh();

    expect((await hits(2, LOCKOUT)).blockedUntil).toBeNull();
    expect((await hits(1, LOCKOUT)).blockedUntil).toEqual(after(500));
  });

  it('does not extend a block with hits made during it', async () => {
    await hits(3, LOCKOUT);
    expect(await store.hit('login_account_ip', KEY, LOCKOUT, after(50))).toMatchObject({ count: 4, blockedUntil: after(500) });
  });

  it('keeps an active block across a window rollover and restarts the count', async () => {
    await hits(3, LOCKOUT);
    expect(await store.hit('login_account_ip', KEY, LOCKOUT, after(150))).toEqual({
      count: 1,
      blockedUntil: after(500),
      windowEndsAt: after(250),
      blockedBefore: true,
    });
  });

  it('restarts the window when a block expires inside it, so the lock really lifts', async () => {
    const policy: Policy = { limit: 3, windowSeconds: 1000, blockSeconds: 100 };
    await hits(3, policy);
    expect(await store.hit('login_account_ip', KEY, policy, after(100))).toEqual({
      count: 1,
      blockedUntil: null,
      windowEndsAt: after(1100),
      blockedBefore: false,
    });
  });

  it('flags a hit as blocked-before only when the previous row had a lock that had not ended', async () => {
    const tripping = await hits(3, LOCKOUT);
    expect(tripping).toMatchObject({ blockedUntil: after(500), blockedBefore: false });

    expect((await store.hit('login_account_ip', KEY, LOCKOUT, after(50))).blockedBefore).toBe(true);
    expect((await store.hit('login_account_ip', KEY, LOCKOUT, after(150))).blockedBefore).toBe(true);
    expect((await store.hit('login_account_ip', KEY, LOCKOUT, after(499))).blockedBefore).toBe(true);
    expect(await store.hit('login_account_ip', KEY, LOCKOUT, after(500))).toMatchObject({ count: 1, blockedBefore: false });
  });

  it('never flags a counter without a lock, nor a lock started by the same millisecond hit', async () => {
    expect((await hits(9, WINDOW)).blockedBefore).toBe(false);
    store = await fresh();

    expect((await hits(1, { limit: 1, windowSeconds: 100, blockSeconds: 60 })).blockedBefore).toBe(false);
  });

  it('blocks on the first hit when the limit is 1', async () => {
    expect((await hits(1, { limit: 1, windowSeconds: 100, blockSeconds: 60 })).blockedUntil).toEqual(after(60));
  });

  it('keeps scopes and keys apart, and reset forgets one counter only', async () => {
    await hits(2, WINDOW);
    await hits(2, WINDOW, T0, OTHER);
    await store.hit('login_account', KEY, WINDOW, T0);

    await store.reset('login_account_ip', KEY);
    await store.reset('login_account_ip', CounterKey.of('login_account_ip', ['never hit']));

    expect((await store.hit('login_account_ip', KEY, WINDOW, T0)).count).toBe(1);
    expect((await store.hit('login_account_ip', OTHER, WINDOW, T0)).count).toBe(3);
    expect((await store.hit('login_account', KEY, WINDOW, T0)).count).toBe(2);
  });
});
