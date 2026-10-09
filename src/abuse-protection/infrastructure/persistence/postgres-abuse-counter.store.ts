import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AbuseCounterStore, ExpiredCounterPurge, HitResult } from '../../domain/abuse-counter.store';
import type { Policy } from '../../domain/policy';
import type { Scope } from '../../domain/scope';
import { isInUnitOfWork } from '../../../platform/persistence/typeorm-unit-of-work';

// $1 scope, $2 key, $3 now, $4 window seconds, $5 limit, $6 end of a new block (null without a block length),
// $7 end of a fresh window. Everything is derived inside the one statement, so concurrent hits serialize on the row.
// A window rolls when it ends or when a lockout inside it ends: a lifted lock starts counting afresh.
const ROLLED = `(c."window_start" + $4::int * interval '1 second' <= $3::timestamptz OR c."blocked_until" <= $3::timestamptz)`;
const NEW_COUNT = `CASE WHEN ${ROLLED} THEN 1 ELSE c."count" + 1 END`;
const NEW_BLOCK = `CASE
  WHEN c."blocked_until" > $3::timestamptz THEN c."blocked_until"
  WHEN ${NEW_COUNT} >= $5::int THEN $6::timestamptz
END`;
const NEW_WINDOW_END = `CASE WHEN ${ROLLED} THEN $7::timestamptz ELSE c."window_start" + $4::int * interval '1 second' END`;

// `prev` locks the existing row and reads whether its lockout had not ended at $3, so the flag comes from the
// PREVIOUS row (RETURNING only sees the new one). `gate` aggregates it, and the INSERT selects FROM `gate`: that
// data dependency makes Postgres finish the lock-and-read before the upsert touches the row. Concurrent hits
// wait on the lock and read the latest committed row. A row that does not exist yet has nothing to lock; two
// first hits racing there can both read "not locked", but the loser's count is already past a limit of 1.
const HIT_SQL = `
  WITH prev AS (
    SELECT "blocked_until" > $3::timestamptz AS "locked" FROM "abuse_counters"
    WHERE "scope" = $1::text AND "key" = $2::bytea FOR UPDATE
  ),
  gate AS (SELECT COALESCE(bool_or("locked"), false) AS "blocked" FROM prev),
  hit AS (
    INSERT INTO "abuse_counters" AS c ("scope", "key", "window_start", "count", "blocked_until", "expires_at")
    SELECT $1::text, $2::bytea, $3::timestamptz, 1,
      CASE WHEN $5::int <= 1 THEN $6::timestamptz END,
      GREATEST($7::timestamptz, CASE WHEN $5::int <= 1 THEN $6::timestamptz END)
    FROM gate
    ON CONFLICT ("scope", "key") DO UPDATE SET
      "window_start" = CASE WHEN ${ROLLED} THEN $3::timestamptz ELSE c."window_start" END,
      "count" = ${NEW_COUNT},
      "blocked_until" = ${NEW_BLOCK},
      "expires_at" = GREATEST(${NEW_WINDOW_END}, ${NEW_BLOCK})
    RETURNING c."count" AS "count", c."blocked_until" AS "blockedUntil",
      c."window_start" + $4::int * interval '1 second' AS "windowEndsAt"
  )
  SELECT hit."count", hit."blockedUntil", hit."windowEndsAt", gate."blocked" AS "blockedBefore" FROM hit, gate`;

// ctid picks the rows without a sort; the sweeper repeats until a batch comes back short.
const DELETE_EXPIRED_SQL = `
  WITH removed AS (
    DELETE FROM "abuse_counters"
    WHERE "ctid" IN (SELECT "ctid" FROM "abuse_counters" WHERE "expires_at" <= $1::timestamptz LIMIT $2::int)
    RETURNING 1
  )
  SELECT count(*)::int AS "deleted" FROM removed`;

function assertOutsideUnitOfWork(operation: string): void {
  if (isInUnitOfWork()) throw new Error(`abuse counter ${operation} called inside a unit of work`);
}

/**
 * Fixed-window counters in Postgres (ADR 36). Every statement goes through the root
 * DataSource manager, never the transactional one from the unit of work: a business
 * rollback must not undo a count, and no row lock may outlive this statement.
 *
 * That means a separate pool connection, so calling the store inside a unit of work would hold one connection
 * while waiting for a second, and enough concurrent requests deadlock the pool. Callers must count before or
 * after the transaction; the store refuses to run inside one rather than risk the hang.
 */
@Injectable()
export class PostgresAbuseCounterStore implements AbuseCounterStore, ExpiredCounterPurge {
  constructor(private readonly dataSource: DataSource) {}

  async hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<HitResult> {
    assertOutsideUnitOfWork('hit');
    const { limit, windowSeconds, blockSeconds } = policy;
    const blockEnd = blockSeconds === null ? null : new Date(now.getTime() + blockSeconds * 1000);
    const windowEnd = new Date(now.getTime() + windowSeconds * 1000);
    // A SELECT answers with the rows themselves (a bare UPDATE would answer [rows, affected]).
    const rows: { count: number; blockedUntil: Date | null; windowEndsAt: Date; blockedBefore: boolean }[] = await this.dataSource.manager.query(
      HIT_SQL,
      [scope, key, now, windowSeconds, limit, blockEnd, windowEnd],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('abuse counter upsert returned no row');
    return { count: row.count, blockedUntil: row.blockedUntil, windowEndsAt: row.windowEndsAt, blockedBefore: row.blockedBefore };
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    assertOutsideUnitOfWork('deleteExpired');
    const rows: { deleted: number }[] = await this.dataSource.manager.query(DELETE_EXPIRED_SQL, [now, limit]);
    return rows[0]?.deleted ?? 0;
  }

  async reset(scope: Scope, key: Buffer): Promise<void> {
    assertOutsideUnitOfWork('reset');
    await this.dataSource.manager.query(`DELETE FROM "abuse_counters" WHERE "scope" = $1 AND "key" = $2`, [scope, key]);
  }
}
