import { FixedClock } from '../../shared-kernel/clock';
import { InMemoryAbuseCounterStore } from '../../../test/support/in-memory-abuse-counter-store';
import { ClientIp } from '../domain/client-ip';
import { ClientRef } from '../domain/client-ref';
import { resolvePolicies, type PolicyOverrides } from '../domain/policy';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';
import { AbuseGuard } from './abuse-guard';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ANA = 'ana@example.com';
const APP = ClientRef.resolved('app');
const ip = (address: string): ClientIp => ClientIp.from(address, undefined);
const IP_X = ip('203.0.113.9');
const IP_Y = ip('198.51.100.1');

function setup(overrides: PolicyOverrides = {}) {
  const store = new InMemoryAbuseCounterStore();
  const clock = new FixedClock(T0);
  const guard = new AbuseGuard({ store, policies: resolvePolicies(overrides), clock });
  return { store, clock, guard };
}

describe('AbuseGuard: login lockout (two counters)', () => {
  const fail = async (guard: AbuseGuard, times: number, email = ANA, from = IP_X) => {
    for (let i = 0; i < times; i++) await guard.recordLoginFailure(APP, email, from);
  };

  it('blocks the pair after 5 failures while another IP still passes', async () => {
    const { guard } = setup();
    await fail(guard, 4);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(false);

    await fail(guard, 1);

    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(true);
    expect(await guard.isLoginBlocked(APP, ANA, IP_Y)).toBe(false);
    expect(await guard.isLoginBlocked(APP, 'bob@example.com', IP_X)).toBe(false);
  });

  it('locks the account for every IP after 50 failures from many IPs', async () => {
    const { guard } = setup();
    for (let i = 1; i <= 50; i++) await guard.recordLoginFailure(APP, ANA, ip(`198.51.100.${i}`));

    expect(await guard.isLoginBlocked(APP, ANA, ip('192.0.2.77'))).toBe(true);
  });

  it('lifts the lock when its 15 minutes pass', async () => {
    const { guard, clock } = setup();
    await fail(guard, 5);

    clock.advanceMs(15 * MINUTE_MS - 1);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(true);
    clock.advanceMs(1);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(false);
  });

  it('does not extend a block with attempts made during it', async () => {
    const { guard, clock } = setup();
    await fail(guard, 5);
    clock.advanceMs(10 * MINUTE_MS);
    await fail(guard, 3);

    clock.advanceMs(5 * MINUTE_MS);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(false);
  });

  it('blocks an email that has no account exactly like a real one: only the key matters', async () => {
    const { guard } = setup();
    await fail(guard, 5, 'nobody@example.com');
    expect(await guard.isLoginBlocked(APP, 'nobody@example.com', IP_X)).toBe(true);
  });

  it('honors a configured pair threshold of 3', async () => {
    const { guard } = setup({ login_account_ip: { limit: 3 } });
    await fail(guard, 3);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(true);
  });

  it('resets the pair counter on success but never the global one', async () => {
    const { guard } = setup({ login_account: { limit: 6 } });
    await fail(guard, 4);
    await guard.recordLoginSuccess(APP, ANA, IP_X);

    // The pair counter restarted, so one more failure is far from 5. The global counter is at 5, then 6.
    await fail(guard, 1);
    expect(await guard.isLoginBlocked(APP, ANA, IP_X)).toBe(false);
    await fail(guard, 1);
    expect(await guard.isLoginBlocked(APP, ANA, IP_Y)).toBe(true);
  });

  it('counts one email in different apps separately', async () => {
    const { guard } = setup();
    for (let i = 0; i < 5; i++) await guard.recordLoginFailure(ClientRef.resolved('app-a'), ANA, IP_X);
    expect(await guard.isLoginBlocked(ClientRef.resolved('app-b'), ANA, IP_X)).toBe(false);
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
    await guard.checkClientIp('email_ip', ClientRef.resolved('app-a'), IP_X);

    expect((await guard.checkClientIp('email_ip', ClientRef.resolved('app-a'), IP_X)).kind).toBe('ip_limited');
    expect((await guard.checkClientIp('email_ip', ClientRef.resolved('app-b'), IP_X)).kind).toBe('allowed');
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
      guard.isLoginBlocked('raw-client-id', ANA, IP_X),
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
    ['isLoginBlocked', 'login_account_ip', (g) => g.isLoginBlocked(APP, ANA, IP_X)],
    ['recordLoginFailure', 'login_account_ip', (g) => g.recordLoginFailure(APP, ANA, IP_X)],
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
