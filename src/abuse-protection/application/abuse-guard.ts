import type { Clock } from '../../shared-kernel/clock';
import type { AbuseCounterStore, CounterRef } from '../domain/abuse-counter.store';
import type { ClientIp } from '../domain/client-ip';
import { CounterKey } from '../domain/counter-key';
import type { PolicyTable } from '../domain/policy';
import type { Scope } from '../domain/scope';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';

/** `client_id` stand-in for requests naming no known app, so random ids cannot dodge or grow the limits. */
export const UNKNOWN_CLIENT_ID = 'unknown';

export type IpDecision = { kind: 'allowed' } | { kind: 'ip_limited'; retryAfterSeconds: number };
export type EmailDecision = { kind: 'allowed' } | { kind: 'account_suppressed' };

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
  checkIp(scope: 'reset_ip' | 'confirm_ip', ip: ClientIp): Promise<IpDecision> {
    return this.hitIp(scope, [ip.key]);
  }

  /** Limits keyed by client and IP. Login treats `ip_limited` as the generic failure, never as a 429. */
  checkClientIp(scope: 'login_ip' | 'email_ip' | 'refresh_ip', clientId: string, ip: ClientIp): Promise<IpDecision> {
    return this.hitIp(scope, [clientId, ip.key]);
  }

  /** Counts one email for this account; past the cap the caller sends nothing and answers as usual. */
  async checkEmailAccount(clientId: string, email: string): Promise<EmailDecision> {
    const { count } = await this.hit('email_account', [clientId, email]);
    return count > this.deps.policies.email_account.limit ? { kind: 'account_suppressed' } : { kind: 'allowed' };
  }

  /** True while the (account, IP) pair is blocked or the account is locked. */
  async isLoginBlocked(clientId: string, email: string, ip: ClientIp): Promise<boolean> {
    const counters: CounterRef[] = [this.pairRef(clientId, email, ip), this.accountRef(clientId, email)];
    const until = await this.guarded(() => this.deps.store.blockedUntil(counters, this.deps.clock.now()));
    return until !== null;
  }

  /** Call after the password check failed. A hit made during a block does not extend it. */
  async recordLoginFailure(clientId: string, email: string, ip: ClientIp): Promise<void> {
    await this.hit('login_account_ip', [clientId, email, ip.key]);
    await this.hit('login_account', [clientId, email]);
  }

  /** Resets the pair counter only: the global counter must survive, or an attacker with one valid login erases it. */
  async recordLoginSuccess(clientId: string, email: string, ip: ClientIp): Promise<void> {
    const { scope, key } = this.pairRef(clientId, email, ip);
    await this.guarded(() => this.deps.store.reset(scope, key));
  }

  private async hitIp(scope: 'login_ip' | 'email_ip' | 'reset_ip' | 'confirm_ip' | 'refresh_ip', parts: string[]) {
    const now = this.deps.clock.now();
    const { count, windowEndsAt } = await this.hit(scope, parts, now);
    if (count <= this.deps.policies[scope].limit) return { kind: 'allowed' } as const;
    // Over the limit means the window has not rolled, so it ends after `now` and the ceiling is at least 1.
    return { kind: 'ip_limited', retryAfterSeconds: Math.ceil((windowEndsAt.getTime() - now.getTime()) / 1000) } as const;
  }

  private hit(scope: Scope, parts: string[], now = this.deps.clock.now()) {
    const policy = this.deps.policies[scope];
    return this.guarded(() => this.deps.store.hit(scope, CounterKey.of(scope, parts), policy, now));
  }

  private pairRef(clientId: string, email: string, ip: ClientIp): CounterRef {
    return { scope: 'login_account_ip', key: CounterKey.of('login_account_ip', [clientId, email, ip.key]) };
  }

  private accountRef(clientId: string, email: string): CounterRef {
    return { scope: 'login_account', key: CounterKey.of('login_account', [clientId, email]) };
  }

  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      throw new TemporarilyUnavailable({ cause });
    }
  }
}
