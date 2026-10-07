import type { Clock } from '../../shared-kernel/clock';
import type { AbuseCounterStore, CounterRef } from '../domain/abuse-counter.store';
import type { ClientIp } from '../domain/client-ip';
import type { ClientRef } from '../domain/client-ref';
import { CounterKey } from '../domain/counter-key';
import type { PolicyTable } from '../domain/policy';
import type { Scope } from '../domain/scope';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';

export type IpDecision = { kind: 'allowed' } | { kind: 'ip_limited'; retryAfterSeconds: number };
export type EmailDecision = { kind: 'allowed' } | { kind: 'account_suppressed' };

/**
 * IP limits that answer `429`. `login_ip` is deliberately not here: login never returns a `429`
 * (ADR 36), so it has its own boolean-only method and the type system keeps it out of these.
 */
type IpOnlyScope = 'reset_ip' | 'confirm_ip';
type ClientIpScope = 'email_ip' | 'refresh_ip';

export interface AbuseGuardDeps {
  store: AbuseCounterStore;
  policies: PolicyTable;
  clock: Clock;
}

/**
 * Rate limits and the two-counter login lockout (ADR 36). Callers run these checks before any
 * account lookup and before bcrypt. Emails must already be normalized. Any store error becomes
 * `TemporarilyUnavailable`: the guard never fails open.
 */
export class AbuseGuard {
  constructor(private readonly deps: AbuseGuardDeps) {}

  /** Limits keyed by IP alone: their bodies carry no `client_id`, and the app is not known yet. */
  checkIp(scope: IpOnlyScope, ip: ClientIp): Promise<IpDecision> {
    return this.hitIp(scope, [ip.key]);
  }

  /** Limits keyed by client and IP. Callers answer `ip_limited` with a `429`. */
  checkClientIp(scope: ClientIpScope, client: ClientRef, ip: ClientIp): Promise<IpDecision> {
    return this.hitIp(scope, [client.key, ip.key]);
  }

  /** Login's per-IP limit: false means the generic login failure. It has no Retry-After and no `429` path. */
  async checkLoginIp(client: ClientRef, ip: ClientIp): Promise<boolean> {
    const { count } = await this.hit('login_ip', [client.key, ip.key]);
    return count <= this.deps.policies.login_ip.limit;
  }

  /** Counts one email for this account; past the cap the caller sends nothing and answers as usual. */
  async checkEmailAccount(client: ClientRef, email: string): Promise<EmailDecision> {
    const { count } = await this.hit('email_account', [client.key, email]);
    return count > this.deps.policies.email_account.limit ? { kind: 'account_suppressed' } : { kind: 'allowed' };
  }

  /** True while the (account, IP) pair is blocked or the account is locked. */
  async isLoginBlocked(client: ClientRef, email: string, ip: ClientIp): Promise<boolean> {
    const counters: CounterRef[] = [this.pairRef(client, email, ip), this.accountRef(client, email)];
    const until = await this.guarded('login_account_ip', () => this.deps.store.blockedUntil(counters, this.deps.clock.now()));
    return until !== null;
  }

  /** Call after the password check failed. A hit made during a block does not extend it. */
  async recordLoginFailure(client: ClientRef, email: string, ip: ClientIp): Promise<void> {
    await this.hit('login_account_ip', [client.key, email, ip.key]);
    await this.hit('login_account', [client.key, email]);
  }

  /** Resets the pair counter only: the global counter must survive, or an attacker with one valid login erases it. */
  async recordLoginSuccess(client: ClientRef, email: string, ip: ClientIp): Promise<void> {
    const { scope, key } = this.pairRef(client, email, ip);
    await this.guarded(scope, () => this.deps.store.reset(scope, key));
  }

  private async hitIp(scope: IpOnlyScope | ClientIpScope, parts: string[]) {
    const now = this.deps.clock.now();
    const { count, windowEndsAt } = await this.hit(scope, parts, now);
    if (count <= this.deps.policies[scope].limit) return { kind: 'allowed' } as const;
    // Over the limit means the window has not rolled, so it ends after `now` and the ceiling is at least 1.
    return { kind: 'ip_limited', retryAfterSeconds: Math.ceil((windowEndsAt.getTime() - now.getTime()) / 1000) } as const;
  }

  private hit(scope: Scope, parts: string[], now = this.deps.clock.now()) {
    const policy = this.deps.policies[scope];
    return this.guarded(scope, () => this.deps.store.hit(scope, CounterKey.of(scope, parts), policy, now));
  }

  private pairRef(client: ClientRef, email: string, ip: ClientIp): CounterRef {
    return { scope: 'login_account_ip', key: CounterKey.of('login_account_ip', [client.key, email, ip.key]) };
  }

  private accountRef(client: ClientRef, email: string): CounterRef {
    return { scope: 'login_account', key: CounterKey.of('login_account', [client.key, email]) };
  }

  private async guarded<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      throw new TemporarilyUnavailable({ cause, scope });
    }
  }
}
