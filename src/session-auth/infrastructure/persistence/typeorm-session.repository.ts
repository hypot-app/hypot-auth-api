import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { RefreshToken } from '../../domain/refresh-token';
import type { Session, SessionRevokedReason } from '../../domain/session';
import type { ConsumedToken, SessionRepository, TokenState } from '../../domain/session.repository';
import { RefreshTokenMapper } from './refresh-token.mapper';
import { RefreshTokenSchema, type RefreshTokenRow } from './refresh-token.schema';
import { SessionMapper } from './session.mapper';
import { SessionSchema, type SessionRow } from './session.schema';

/**
 * ADR 35: the token, its session and the app are checked and the token is rotated in one statement,
 * with no SELECT ... FOR UPDATE. A second concurrent caller waits for the row lock, re-checks
 * `consumed_at IS NULL` and matches nothing.
 */
const CONSUME_SQL = `
  UPDATE "refresh_tokens" t
  SET "consumed_at" = $1, "replaced_by_hash" = $2, "consumed_ip_hash" = $3
  FROM "auth_sessions" s
  WHERE t."token_hash" = $4 AND t."consumed_at" IS NULL AND t."revoked_at" IS NULL AND t."expires_at" > $1
    AND s."id" = t."session_id" AND s."app_id" = $5
    AND s."revoked_at" IS NULL AND s."expires_at" > $1
  RETURNING t."session_id", s."user_id", s."expires_at"`;

const TOKEN_STATE_SQL = `
  SELECT t."session_id", s."app_id", s."user_id", t."expires_at" AS "token_expires_at", t."consumed_at",
         t."consumed_ip_hash", t."replaced_by_hash", t."grace_used_at", t."revoked_at" AS "token_revoked_at",
         s."expires_at" AS "session_expires_at", s."revoked_at" AS "session_revoked_at"
  FROM "refresh_tokens" t JOIN "auth_sessions" s ON s."id" = t."session_id"
  WHERE t."token_hash" = $1`;

/** Only a rotated, unrevoked token can claim its grace, and only once. */
const CLAIM_GRACE_SQL = `
  UPDATE "refresh_tokens" SET "grace_used_at" = $1
  WHERE "token_hash" = $2 AND "grace_used_at" IS NULL AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL
  RETURNING "replaced_by_hash"`;

const REVOKE_TOKEN_SQL = `
  UPDATE "refresh_tokens" SET "revoked_at" = $1
  WHERE "token_hash" = $2 AND "consumed_at" IS NULL AND "revoked_at" IS NULL
  RETURNING 1`;

/** Conditional on purpose: a logout or revoke-all that committed after the caller's read must be seen here. */
const TOUCH_SESSION_SQL = `
  UPDATE "auth_sessions" SET "last_used_at" = $1
  WHERE "id" = $2 AND "revoked_at" IS NULL AND "expires_at" > $1
  RETURNING 1`;

/** `revoked_at IS NULL` keeps the first reason and time. */
const REVOKE_SESSION_SQL = `
  UPDATE "auth_sessions" SET "revoked_at" = $1, "revoked_reason" = $2
  WHERE "id" = $3 AND "revoked_at" IS NULL`;

const REVOKE_ALL_FOR_USER_SQL = `
  UPDATE "auth_sessions" SET "revoked_at" = $1, "revoked_reason" = $2
  WHERE "user_id" = $3 AND "revoked_at" IS NULL
  RETURNING 1`;

/** Only sessions still open: the count is the sessions that stopped working, not rows that were dead already. */
const REVOKE_ALL_SQL = `
  UPDATE "auth_sessions" SET "revoked_at" = $1, "revoked_reason" = $2
  WHERE "revoked_at" IS NULL AND "expires_at" > $1`;

interface TokenStateRow {
  session_id: string;
  app_id: string;
  user_id: string;
  token_expires_at: Date;
  consumed_at: Date | null;
  consumed_ip_hash: Buffer | null;
  replaced_by_hash: Buffer | null;
  grace_used_at: Date | null;
  token_revoked_at: Date | null;
  session_expires_at: Date;
  session_revoked_at: Date | null;
}

@Injectable()
export class TypeOrmSessionRepository implements SessionRepository {
  constructor(private readonly dataSource: DataSource) {}

  async open(session: Session, firstToken: RefreshToken): Promise<void> {
    const manager = currentManager(this.dataSource);
    await manager.getRepository<SessionRow>(SessionSchema).insert(SessionMapper.toPersistence(session));
    await manager.getRepository<RefreshTokenRow>(RefreshTokenSchema).insert(RefreshTokenMapper.toPersistence(firstToken));
  }

  async addToken(token: RefreshToken): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository<RefreshTokenRow>(RefreshTokenSchema)
      .insert(RefreshTokenMapper.toPersistence(token));
  }

  async consume(hash: Buffer, appId: string, now: Date, successorHash: Buffer, ipHash: Buffer): Promise<ConsumedToken | null> {
    // TypeORM's postgres driver answers an UPDATE with [rows, affectedCount].
    const [rows]: [{ session_id: string; user_id: string; expires_at: Date }[], number] = await currentManager(
      this.dataSource,
    ).query(CONSUME_SQL, [now, successorHash, ipHash, hash, appId]);
    const row = rows[0];
    return row === undefined ? null : { sessionId: row.session_id, userId: row.user_id, sessionExpiresAt: row.expires_at };
  }

  async findTokenState(hash: Buffer): Promise<TokenState | null> {
    const rows: TokenStateRow[] = await currentManager(this.dataSource).query(TOKEN_STATE_SQL, [hash]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      sessionId: row.session_id,
      appId: row.app_id,
      userId: row.user_id,
      tokenExpiresAt: row.token_expires_at,
      consumedAt: row.consumed_at,
      consumedIpHash: row.consumed_ip_hash,
      replacedByHash: row.replaced_by_hash,
      graceUsedAt: row.grace_used_at,
      tokenRevokedAt: row.token_revoked_at,
      sessionExpiresAt: row.session_expires_at,
      sessionRevokedAt: row.session_revoked_at,
    };
  }

  async touch(sessionId: string, now: Date): Promise<boolean> {
    const [rows]: [unknown[], number] = await currentManager(this.dataSource).query(TOUCH_SESSION_SQL, [now, sessionId]);
    return rows.length > 0;
  }

  async revoke(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<void> {
    await currentManager(this.dataSource).query(REVOKE_SESSION_SQL, [now, reason, sessionId]);
  }

  async revokeAllForUser(userId: string, reason: SessionRevokedReason, now: Date): Promise<number> {
    const [rows]: [unknown[], number] = await currentManager(this.dataSource).query(REVOKE_ALL_FOR_USER_SQL, [now, reason, userId]);
    return rows.length;
  }

  async revokeAll(reason: SessionRevokedReason, now: Date): Promise<number> {
    // No RETURNING: the number of rows is the driver's affected count, not a result set to carry around.
    const [, affected]: [unknown[], number] = await currentManager(this.dataSource).query(REVOKE_ALL_SQL, [now, reason]);
    return affected;
  }

  async claimGrace(hash: Buffer, now: Date): Promise<Buffer | null> {
    const [rows]: [{ replaced_by_hash: Buffer | null }[], number] = await currentManager(this.dataSource).query(CLAIM_GRACE_SQL, [
      now,
      hash,
    ]);
    return rows[0]?.replaced_by_hash ?? null;
  }

  async revokeToken(hash: Buffer, now: Date): Promise<boolean> {
    const [rows]: [unknown[], number] = await currentManager(this.dataSource).query(REVOKE_TOKEN_SQL, [now, hash]);
    return rows.length > 0;
  }
}
