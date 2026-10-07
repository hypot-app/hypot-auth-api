import type { AbuseCounterStore, CounterRef, HitResult } from '../../src/abuse-protection/domain/abuse-counter.store';
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

  async hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<HitResult> {
    this.assertAvailable();
    const t = now.getTime();
    const id = `${scope}:${key.toString('hex')}`;
    const old = this.rows.get(id);
    const rolled = old === undefined || old.windowStart + policy.windowSeconds * 1000 <= t;
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
    };
  }

  async blockedUntil(counters: readonly CounterRef[], now: Date): Promise<Date | null> {
    this.assertAvailable();
    const ends = counters
      .map((c) => this.rows.get(`${c.scope}:${c.key.toString('hex')}`)?.blockedUntil ?? null)
      .filter((end): end is number => end !== null && end > now.getTime());
    return ends.length === 0 ? null : new Date(Math.max(...ends));
  }

  async reset(scope: Scope, key: Buffer): Promise<void> {
    this.assertAvailable();
    this.rows.delete(`${scope}:${key.toString('hex')}`);
  }

  private assertAvailable(): void {
    if (this.failWith !== undefined) throw this.failWith;
  }
}
