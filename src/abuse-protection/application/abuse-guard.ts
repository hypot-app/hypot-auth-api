import type { Clock } from '../../shared-kernel/clock';
import type { AbuseCounterStore, HitResult } from '../domain/abuse-counter.store';
import type { ClientIp } from '../domain/client-ip';
import type { ClientRef } from '../domain/client-ref';
import { CounterKey } from '../domain/counter-key';
import type { PolicyTable } from '../domain/policy';
import type { Scope } from '../domain/scope';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';

export type IpDecision = { kind: 'allowed' } | { kind: 'ip_limited'; retryAfterSeconds: number };
export type EmailDecision = { kind: 'allowed' } | { kind: 'account_suppressed' };
export type LoginAttemptDecision = 'allowed' | 'blocked';

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

  /**
   * Counts the attempt BEFORE the password is checked, with one atomic upsert per counter, so
   * parallel attempts cannot all pass a read-only check (check-then-act). Exactly `limit` attempts
   * are allowed per window; the rest are `blocked`. The account counter is skipped when the pair is
   * already blocked, so an attacker hammering from a blocked IP cannot lock the account for everyone.
   * Both counters therefore count attempts, not failures: a success refunds only the pair
   * (`recordLoginSuccess`), and the account counter keeps it, because giving it back would reopen the race.
   */
  async beginLoginAttempt(client: ClientRef, email: string, ip: ClientIp): Promise<LoginAttemptDecision> {
    const now = this.deps.clock.now();
    const pair = await this.hit('login_account_ip', [client.key, email, ip.key], now);
    if (this.exceeds('login_account_ip', pair, now)) return 'blocked';
    const account = await this.hit('login_account', [client.key, email], now);
    return this.exceeds('login_account', account, now) ? 'blocked' : 'allowed';
  }

  /** Refunds the pair counter only: the global one must survive, or an attacker with one valid login erases it. */
  async recordLoginSuccess(client: ClientRef, email: string, ip: ClientIp): Promise<void> {
    const key = CounterKey.of('login_account_ip', [client.key, email, ip.key]);
    await this.guarded('login_account_ip', () => this.deps.store.reset('login_account_ip', key));
  }

  /**
   * True when this hit must not pass. The hit that reaches the limit starts the block but is still
   * the last allowed one. A block older than this hit (blockedUntil is not `now + blockSeconds`) blocks
   * even when the count restarted in a new window.
   */
  private exceeds(scope: Scope, result: HitResult, now: Date): boolean {
    const { limit, blockSeconds } = this.deps.policies[scope];
    if (result.count > limit) return true;
    if (result.blockedUntil === null) return false;
    return result.blockedUntil.getTime() !== now.getTime() + (blockSeconds ?? 0) * 1000;
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

  private async guarded<T>(scope: Scope, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      throw new TemporarilyUnavailable({ cause, scope });
    }
  }
}
