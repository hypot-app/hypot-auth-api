import type { AbuseCounterStore, HitResult } from '../../src/abuse-protection/domain/abuse-counter.store';
import type { Policy } from '../../src/abuse-protection/domain/policy';
import type { Scope } from '../../src/abuse-protection/domain/scope';

interface Row {
  windowStart: number;
  count: number;
  blockedUntil: number | null;
}

/** Same rules as the SQL upsert of PostgresAbuseCounterStore, without a database. */
export class InMemoryAbuseCounterStore implements AbuseCounterStore {
  private readonly rows = new Map<string, Row>();
  /** Set to make every call fail, as an unavailable database would. */
  failWith: Error | undefined;
  /** How many hits each scope has seen, so a test can say a request did or did not count. */
  readonly hitCounts: Partial<Record<Scope, number>> = {};

  async hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<HitResult> {
    this.assertAvailable();
    this.hitCounts[scope] = (this.hitCounts[scope] ?? 0) + 1;
    const t = now.getTime();
    const id = `${scope}:${key.toString('hex')}`;
    const old = this.rows.get(id);
    const rolled =
      old === undefined || old.windowStart + policy.windowSeconds * 1000 <= t || (old.blockedUntil !== null && old.blockedUntil <= t);
    const blockedBefore = old?.blockedUntil != null && old.blockedUntil > t;
    const count = rolled ? 1 : old.count + 1;
    let blockedUntil = old?.blockedUntil != null && old.blockedUntil > t ? old.blockedUntil : null;
    if (blockedUntil === null && count >= policy.limit && policy.blockSeconds !== null) {
      blockedUntil = t + policy.blockSeconds * 1000;
    }
    const windowStart = rolled ? t : old.windowStart;
    this.rows.set(id, { windowStart, count, blockedUntil });
    return {
      count,
      blockedUntil: blockedUntil === null ? null : new Date(blockedUntil),
      windowEndsAt: new Date(windowStart + policy.windowSeconds * 1000),
      blockedBefore,
    };
  }

  async reset(scope: Scope, key: Buffer): Promise<void> {
    this.assertAvailable();
    this.rows.delete(`${scope}:${key.toString('hex')}`);
  }

  private assertAvailable(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
}
