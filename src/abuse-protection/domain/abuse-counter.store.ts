import type { Policy } from './policy';
import type { Scope } from './scope';

export interface HitResult {
  /** Hits in the current window, this one included. */
  count: number;
  /** End of an active lockout, or null. */
  blockedUntil: Date | null;
  /** End of the current window; the source of `Retry-After`. */
  windowEndsAt: Date;
}

/** Port for the fixed-window counters of ADR 36. */
export interface AbuseCounterStore {
  /** Atomically counts one event. Reaching `policy.limit` starts a lockout when the policy has a block length. */
  hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<HitResult>;
  /** Forgets one counter; a missing one is not an error. */
  reset(scope: Scope, key: Buffer): Promise<void>;
}

/** Housekeeping port for the sweeper. */
export interface ExpiredCounterPurge {
  /** Deletes up to `limit` counters whose `expires_at` has passed; returns how many. */
  deleteExpired(now: Date, limit: number): Promise<number>;
}

export const ABUSE_COUNTER_STORE = Symbol('AbuseCounterStore');
