import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AbuseCounterStore, ExpiredCounterPurge, HitResult } from '../../domain/abuse-counter.store';
import type { Policy } from '../../domain/policy';
import type { Scope } from '../../domain/scope';

// $1 scope, $2 key, $3 now, $4 window seconds, $5 limit, $6 end of a new block (null without a block length),
// $7 end of a fresh window. Everything is derived inside the one statement, so concurrent hits serialize on the row.
const ROLLED = `c."window_start" + $4::int * interval '1 second' <= $3::timestamptz`;
const NEW_COUNT = `CASE WHEN ${ROLLED} THEN 1 ELSE c."count" + 1 END`;
const NEW_BLOCK = `CASE
  WHEN c."blocked_until" > $3::timestamptz THEN c."blocked_until"
  WHEN ${NEW_COUNT} >= $5::int THEN $6::timestamptz
END`;
const NEW_WINDOW_END = `CASE WHEN ${ROLLED} THEN $7::timestamptz ELSE c."window_start" + $4::int * interval '1 second' END`;

const HIT_SQL = `
  INSERT INTO "abuse_counters" AS c ("scope", "key", "window_start", "count", "blocked_until", "expires_at")
  VALUES ($1, $2, $3::timestamptz, 1,
    CASE WHEN $5::int <= 1 THEN $6::timestamptz END,
    GREATEST($7::timestamptz, CASE WHEN $5::int <= 1 THEN $6::timestamptz END))
  ON CONFLICT ("scope", "key") DO UPDATE SET
    "window_start" = CASE WHEN ${ROLLED} THEN $3::timestamptz ELSE c."window_start" END,
    "count" = ${NEW_COUNT},
    "blocked_until" = ${NEW_BLOCK},
    "expires_at" = GREATEST(${NEW_WINDOW_END}, ${NEW_BLOCK})
  RETURNING c."count" AS "count", c."blocked_until" AS "blockedUntil",
    c."window_start" + $4::int * interval '1 second' AS "windowEndsAt"`;

// ctid picks the rows without a sort; the sweeper repeats until a batch comes back short.
const DELETE_EXPIRED_SQL = `
  WITH removed AS (
    DELETE FROM "abuse_counters"
    WHERE "ctid" IN (SELECT "ctid" FROM "abuse_counters" WHERE "expires_at" <= $1::timestamptz LIMIT $2::int)
    RETURNING 1
  )
  SELECT count(*)::int AS "deleted" FROM removed`;

/**
 * Fixed-window counters in Postgres (ADR 36). Every statement goes through the root
 * DataSource manager, never the transactional one from the unit of work: a business
 * rollback must not undo a count, and no row lock may outlive this statement.
 */
@Injectable()
export class PostgresAbuseCounterStore implements AbuseCounterStore, ExpiredCounterPurge {
  constructor(private readonly dataSource: DataSource) {}

  async hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<HitResult> {
    const { limit, windowSeconds, blockSeconds } = policy;
    const blockEnd = blockSeconds === null ? null : new Date(now.getTime() + blockSeconds * 1000);
    const windowEnd = new Date(now.getTime() + windowSeconds * 1000);
    // An INSERT answers with the rows themselves (an UPDATE would answer [rows, affected]).
    const rows: { count: number; blockedUntil: Date | null; windowEndsAt: Date }[] = await this.dataSource.manager.query(
      HIT_SQL,
      [scope, key, now, windowSeconds, limit, blockEnd, windowEnd],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('abuse counter upsert returned no row');
    return { count: row.count, blockedUntil: row.blockedUntil, windowEndsAt: row.windowEndsAt };
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    const rows: { deleted: number }[] = await this.dataSource.manager.query(DELETE_EXPIRED_SQL, [now, limit]);
    return rows[0]?.deleted ?? 0;
  }

  async reset(scope: Scope, key: Buffer): Promise<void> {
    await this.dataSource.manager.query(`DELETE FROM "abuse_counters" WHERE "scope" = $1 AND "key" = $2`, [scope, key]);
  }
}
