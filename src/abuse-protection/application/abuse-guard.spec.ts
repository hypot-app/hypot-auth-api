import { FixedClock } from '../../shared-kernel/clock';
import { anApp } from '../../../test/support/app-fixture';
import { InMemoryAbuseCounterStore } from '../../../test/support/in-memory-abuse-counter-store';
import type { AbuseCounterStore, HitResult } from '../domain/abuse-counter.store';
import { ClientIp } from '../domain/client-ip';
import { ClientRef } from '../domain/client-ref';
import { resolvePolicies, type PolicyOverrides } from '../domain/policy';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';
import { AbuseGuard } from './abuse-guard';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ANA = 'ana@example.com';
const APP = ClientRef.resolved(anApp({ id: 'app' }));
const ip = (address: string): ClientIp => ClientIp.from(address, undefined);
const IP_X = ip('203.0.113.9');
const IP_Y = ip('198.51.100.1');

function setup(overrides: PolicyOverrides = {}) {
  const store = new InMemoryAbuseCounterStore();
  const clock = new FixedClock(T0);
  const guard = new AbuseGuard({ store, policies: resolvePolicies(overrides), clock });
  return { store, clock, guard };
}

describe('AbuseGuard: login lockout (atomic pre-count)', () => {
  /** Runs `times` attempts one after another and returns every decision. */
  const attempts = async (guard: AbuseGuard, times: number, email = ANA, from = IP_X) => {
    const decisions: string[] = [];
    for (let i = 0; i < times; i++) decisions.push(await guard.beginLoginAttempt(APP, email, from));
    return decisions;
  };

  it('allows 5 attempts from a pair, blocks the 6th, and still lets another IP or email in', async () => {
    const { guard } = setup();
    expect(await attempts(guard, 5)).toEqual(Array(5).fill('allowed'));

    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('blocked');
    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, 'bob@example.com', IP_X)).toBe('allowed');
  });

  it('lets exactly the limit through when attempts for one pair arrive in parallel', async () => {
    const { guard } = setup();

    const decisions = await Promise.all(Array.from({ length: 12 }, () => guard.beginLoginAttempt(APP, ANA, IP_X)));

    expect(decisions.filter((d) => d === 'allowed')).toHaveLength(5);
    expect(decisions.filter((d) => d === 'blocked')).toHaveLength(7);
  });

  it('locks the account for every IP after 50 attempts from many IPs, however parallel', async () => {
    const { guard } = setup();

    const decisions = await Promise.all(
      Array.from({ length: 60 }, (_, i) => guard.beginLoginAttempt(APP, ANA, ip(`198.51.100.${i}`))),
    );

    expect(decisions.filter((d) => d === 'allowed')).toHaveLength(50);
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.77'))).toBe('blocked');
  });

  it('lifts a pair block when its 15 minutes pass', async () => {
    const { guard, clock } = setup();
    await attempts(guard, 5);

    clock.advanceMs(15 * MINUTE_MS - 1);
    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('blocked');
    clock.advanceMs(1);
    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('allowed');
  });

  it('does not extend a block with attempts made during it', async () => {
    const { guard, clock } = setup();
    await attempts(guard, 5);
    clock.advanceMs(10 * MINUTE_MS);
    await attempts(guard, 3);

    clock.advanceMs(5 * MINUTE_MS);
    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('allowed');
  });

  it('blocks an email that has no account exactly like a real one: only the key matters', async () => {
    const { guard } = setup();
    await attempts(guard, 5, 'nobody@example.com');
    expect(await guard.beginLoginAttempt(APP, 'nobody@example.com', IP_X)).toBe('blocked');
  });

  it('honors a configured pair threshold of 3', async () => {
    const { guard } = setup({ login_account_ip: { limit: 3 } });
    expect(await attempts(guard, 4)).toEqual(['allowed', 'allowed', 'allowed', 'blocked']);
  });

  it('refunds the pair on success but never the global counter', async () => {
    const { guard } = setup({ login_account: { limit: 6 } });
    await attempts(guard, 4);
    await guard.recordLoginSuccess(APP, ANA, IP_X);

    // The pair restarted from zero, the global counter kept its 4: two more fit, the third from anywhere does not.
    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('blocked');
  });

  it('does not charge the account for attempts a blocked pair keeps making', async () => {
    const { guard } = setup({ login_account: { limit: 7 } });
    await attempts(guard, 5);
    await attempts(guard, 20);

    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, ANA, IP_Y)).toBe('blocked');
  });

  it('keeps a lock that outlives the window it was set in', async () => {
    const { guard, clock } = setup({ login_account: { limit: 3 } });
    await guard.beginLoginAttempt(APP, ANA, IP_X);
    clock.advanceMs(46 * MINUTE_MS);
    await guard.beginLoginAttempt(APP, ANA, IP_X);
    await guard.beginLoginAttempt(APP, ANA, IP_Y);

    // At minute 60 the global window rolled (count 1), but the lock runs until minute 61.
    clock.advanceMs(14 * MINUTE_MS);
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.1'))).toBe('blocked');
    clock.advanceMs(MINUTE_MS);
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.2'))).toBe('allowed');
  });

  it('lifts the global lock after 15 minutes and starts counting afresh, even inside the same window', async () => {
    const { guard, clock } = setup();
    for (let i = 0; i < 50; i++) await guard.beginLoginAttempt(APP, ANA, ip(`198.51.100.${i}`));
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.1'))).toBe('blocked');

    clock.advanceMs(15 * MINUTE_MS - 1);
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.2'))).toBe('blocked');
    clock.advanceMs(1);
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.3'))).toBe('allowed');
    expect(await guard.beginLoginAttempt(APP, ANA, ip('192.0.2.4'))).toBe('allowed');
  });

  it('counts one email in different apps separately', async () => {
    const { guard } = setup();
    await attempts(guard, 6);
    expect(await guard.beginLoginAttempt(ClientRef.resolved(anApp({ id: 'app-b' })), ANA, IP_X)).toBe('allowed');
  });
});

describe('AbuseGuard: per-IP decisions', () => {
  it('allows up to the limit, then limits with the whole seconds left in the window', async () => {
    const { guard, clock } = setup({ email_ip: { limit: 2 } });
    expect(await guard.checkClientIp('email_ip', APP, IP_X)).toEqual({ kind: 'allowed' });
    expect(await guard.checkClientIp('email_ip', APP, IP_X)).toEqual({ kind: 'allowed' });

    clock.advanceMs(1_500);
    expect(await guard.checkClientIp('email_ip', APP, IP_X)).toEqual({ kind: 'ip_limited', retryAfterSeconds: 3599 });
  });

  it('never reports a Retry-After below 1 second', async () => {
    const { guard, clock } = setup({ reset_ip: { limit: 1 } });
    await guard.checkIp('reset_ip', IP_X);
    clock.advanceMs(HOUR_MS - 1);
    expect(await guard.checkIp('reset_ip', IP_X)).toEqual({ kind: 'ip_limited', retryAfterSeconds: 1 });
  });

  it('starts a fresh window once the old one ends', async () => {
    const { guard, clock } = setup({ confirm_ip: { limit: 1 } });
    await guard.checkIp('confirm_ip', IP_X);
    expect((await guard.checkIp('confirm_ip', IP_X)).kind).toBe('ip_limited');

    clock.advanceMs(HOUR_MS);
    expect(await guard.checkIp('confirm_ip', IP_X)).toEqual({ kind: 'allowed' });
  });

  it('keeps IPs, and the reset, confirm and refresh scopes, apart', async () => {
    const { guard } = setup({ reset_ip: { limit: 1 }, confirm_ip: { limit: 1 }, refresh_ip: { limit: 1 } });
    await guard.checkIp('reset_ip', IP_X);

    expect((await guard.checkIp('reset_ip', IP_X)).kind).toBe('ip_limited');
    expect((await guard.checkIp('reset_ip', IP_Y)).kind).toBe('allowed');
    expect((await guard.checkIp('confirm_ip', IP_X)).kind).toBe('allowed');
    expect((await guard.checkClientIp('refresh_ip', APP, IP_X)).kind).toBe('allowed');
  });

  it('keys the client-scoped limits by client, with one shared sentinel for unknown clients', async () => {
    const { guard } = setup({ email_ip: { limit: 1 } });
    await guard.checkClientIp('email_ip', ClientRef.resolved(anApp({ id: 'app-a' })), IP_X);

    expect((await guard.checkClientIp('email_ip', ClientRef.resolved(anApp({ id: 'app-a' })), IP_X)).kind).toBe('ip_limited');
    expect((await guard.checkClientIp('email_ip', ClientRef.resolved(anApp({ id: 'app-b' })), IP_X)).kind).toBe('allowed');
    await guard.checkClientIp('email_ip', ClientRef.unknown(), IP_X);
    expect((await guard.checkClientIp('email_ip', ClientRef.unknown(), IP_X)).kind).toBe('ip_limited');
  });
});

describe('AbuseGuard: the login IP limit has no way to produce a 429', () => {
  it('answers a plain boolean: true up to the limit, false past it, per client and IP', async () => {
    const { guard } = setup({ login_ip: { limit: 2 } });
    expect(await guard.checkLoginIp(APP, IP_X)).toBe(true);
    expect(await guard.checkLoginIp(APP, IP_X)).toBe(true);

    expect(await guard.checkLoginIp(APP, IP_X)).toBe(false);
    expect(await guard.checkLoginIp(APP, IP_Y)).toBe(true);
    expect(await guard.checkLoginIp(ClientRef.unknown(), IP_X)).toBe(true);
  });

  it('counts apart from the email_ip limit of the same client and IP', async () => {
    const { guard } = setup({ login_ip: { limit: 1 }, email_ip: { limit: 1 } });
    await guard.checkLoginIp(APP, IP_X);

    expect((await guard.checkClientIp('email_ip', APP, IP_X)).kind).toBe('allowed');
  });

  it('is enforced by types: generic IP checks refuse login_ip, and clients must be ClientRefs (npm run typecheck)', () => {
    const misuse = (guard: AbuseGuard) => [
      // @ts-expect-error login_ip must go through checkLoginIp, which cannot return a Retry-After
      guard.checkClientIp('login_ip', APP, IP_X),
      // @ts-expect-error the IP-only checks refuse login_ip as well
      guard.checkIp('login_ip', IP_X),
      // @ts-expect-error a raw client_id is not a ClientRef
      guard.checkClientIp('email_ip', 'raw-client-id', IP_X),
      // @ts-expect-error a raw client_id is not a ClientRef
      guard.checkLoginIp('raw-client-id', IP_X),
      // @ts-expect-error a raw client_id is not a ClientRef
      guard.beginLoginAttempt('raw-client-id', ANA, IP_X),
      // @ts-expect-error a raw client_id is not a ClientRef
      guard.checkEmailAccount('raw-client-id', ANA),
    ];
    expect(misuse).toBeInstanceOf(Function);
  });
});

describe('AbuseGuard: per-account email cap', () => {
  it('allows 3 emails an hour and silently suppresses the 4th, whatever the caller IP', async () => {
    const { guard } = setup();
    for (let i = 0; i < 3; i++) expect(await guard.checkEmailAccount(APP, ANA)).toEqual({ kind: 'allowed' });

    expect(await guard.checkEmailAccount(APP, ANA)).toEqual({ kind: 'account_suppressed' });
    expect(await guard.checkEmailAccount(APP, 'bob@example.com')).toEqual({ kind: 'allowed' });
  });

  it('honors a configured threshold', async () => {
    const { guard } = setup({ email_account: { limit: 1 } });
    await guard.checkEmailAccount(APP, ANA);
    expect((await guard.checkEmailAccount(APP, ANA)).kind).toBe('account_suppressed');
  });
});

describe('AbuseGuard: a store failure fails closed', () => {
  const calls: [string, string, (guard: AbuseGuard) => Promise<unknown>][] = [
    ['checkIp', 'reset_ip', (g) => g.checkIp('reset_ip', IP_X)],
    ['checkClientIp', 'email_ip', (g) => g.checkClientIp('email_ip', APP, IP_X)],
    ['checkLoginIp', 'login_ip', (g) => g.checkLoginIp(APP, IP_X)],
    ['checkEmailAccount', 'email_account', (g) => g.checkEmailAccount(APP, ANA)],
    ['beginLoginAttempt', 'login_account_ip', (g) => g.beginLoginAttempt(APP, ANA, IP_X)],
    ['recordLoginSuccess', 'login_account_ip', (g) => g.recordLoginSuccess(APP, ANA, IP_X)],
  ];

  it.each(calls)('%s raises TemporarilyUnavailable naming the %s scope and keeping the cause', async (_n, scope, call) => {
    const { guard, store } = setup();
    store.failWith = new Error('connection refused');

    const error = await call(guard).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TemporarilyUnavailable);
    expect((error as TemporarilyUnavailable).cause).toBe(store.failWith);
    expect((error as TemporarilyUnavailable).scope).toBe(scope);
  });
});

describe('AbuseGuard: the store, not date arithmetic, says whether a lock predates the hit', () => {
  /** Answers the same HitResult to every hit, so only the store's own signal can steer the guard. */
  const guardAnswering = (result: Omit<HitResult, 'windowEndsAt'>) => {
    const store: AbuseCounterStore = {
      hit: async () => ({ ...result, windowEndsAt: new Date(T0.getTime() + HOUR_MS) }),
      reset: async () => undefined,
    };
    return new AbuseGuard({ store, policies: resolvePolicies({}), clock: new FixedClock(T0) });
  };

  it('allows the hit that only started the lock, even when its end is not now + block length', async () => {
    const guard = guardAnswering({ count: 5, blockedUntil: new Date(T0.getTime() + 1_000), blockedBefore: false });

    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('allowed');
  });

  it('blocks a hit whose previous row was already locked, even when the end equals now + block length', async () => {
    const guard = guardAnswering({ count: 1, blockedUntil: new Date(T0.getTime() + 15 * MINUTE_MS), blockedBefore: true });

    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('blocked');
  });

  it('blocks past the limit whatever the flag says', async () => {
    const guard = guardAnswering({ count: 6, blockedUntil: null, blockedBefore: false });

    expect(await guard.beginLoginAttempt(APP, ANA, IP_X)).toBe('blocked');
  });
});
