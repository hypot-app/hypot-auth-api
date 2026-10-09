import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { RetentionPurge } from './retention-purge';

// Each statement picks one batch by ctid (no sort), deletes it and answers with the count. The session statement
// deletes the refresh tokens in the same statement: Postgres checks the foreign key at the end of the statement,
// so the child and parent deletes are atomic without a transaction, and therefore without a second connection.
const DELETE_SESSIONS_SQL = `
  WITH doomed AS (
    SELECT "id" FROM "auth_sessions" WHERE "expires_at" < $1::timestamptz LIMIT $2::int
  ),
  removed_tokens AS (
    DELETE FROM "refresh_tokens" WHERE "session_id" IN (SELECT "id" FROM doomed)
  ),
  removed AS (
    DELETE FROM "auth_sessions" WHERE "id" IN (SELECT "id" FROM doomed) RETURNING 1
  )
  SELECT count(*)::int AS "deleted" FROM removed`;

const DELETE_ONE_TIME_TOKENS_SQL = `
  WITH removed AS (
    DELETE FROM "one_time_tokens"
    WHERE "ctid" IN (SELECT "ctid" FROM "one_time_tokens" WHERE "expires_at" < $1::timestamptz LIMIT $2::int)
    RETURNING 1
  )
  SELECT count(*)::int AS "deleted" FROM removed`;

// Pending rows are the live queue and are excluded by the status filter, which also matches the partial index.
const DELETE_SETTLED_OUTBOX_SQL = `
  WITH removed AS (
    DELETE FROM "email_outbox"
    WHERE "ctid" IN (
      SELECT "ctid" FROM "email_outbox"
      WHERE "status" IN ('sent', 'failed') AND "created_at" < $1::timestamptz LIMIT $2::int
    )
    RETURNING 1
  )
  SELECT count(*)::int AS "deleted" FROM removed`;

/**
 * Retention deletes as plain SQL on the root manager (ADR 35). It spans the tables of three modules on purpose: the
 * job is operational plumbing with no domain rules, so it lives in `platform` and reads no domain code. It is never
 * called inside a unit of work.
 */
@Injectable()
export class PostgresRetentionPurge implements RetentionPurge {
  constructor(private readonly dataSource: DataSource) {}

  deleteExpiredSessions(cutoff: Date, limit: number): Promise<number> {
    return this.run(DELETE_SESSIONS_SQL, cutoff, limit);
  }

  deleteExpiredOneTimeTokens(cutoff: Date, limit: number): Promise<number> {
    return this.run(DELETE_ONE_TIME_TOKENS_SQL, cutoff, limit);
  }

  deleteSettledOutbox(cutoff: Date, limit: number): Promise<number> {
    return this.run(DELETE_SETTLED_OUTBOX_SQL, cutoff, limit);
  }

  private async run(sql: string, cutoff: Date, limit: number): Promise<number> {
    // A SELECT answers with the rows themselves (a bare DELETE would answer [rows, affected]).
    const rows: { deleted: number }[] = await this.dataSource.manager.query(sql, [cutoff, limit]);
    return rows[0]?.deleted ?? 0;
  }
}
