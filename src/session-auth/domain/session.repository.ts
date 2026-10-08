import type { RefreshToken } from './refresh-token';
import type { Session, SessionRevokedReason } from './session';

/** What a successful rotation hands back: whose session the presented token belongs to. */
export interface ConsumedToken {
  sessionId: string;
  userId: string;
  sessionExpiresAt: Date;
}

/** Everything the reuse rules (ADR 35) need to know about a presented token. */
export interface TokenState {
  sessionId: string;
  appId: string;
  userId: string;
  tokenExpiresAt: Date;
  consumedAt: Date | null;
  consumedIpHash: Buffer | null;
  replacedByHash: Buffer | null;
  graceUsedAt: Date | null;
  tokenRevokedAt: Date | null;
  sessionExpiresAt: Date;
  sessionRevokedAt: Date | null;
}

/**
 * Port: storage of sessions and their refresh tokens (ADR 35). Implementations join the current
 * unit of work. Every state change is one conditional statement, so concurrent callers cannot
 * both win and no whole-row write can undo another request's change.
 */
export interface SessionRepository {
  /** Stores a new session together with its first token. */
  open(session: Session, firstToken: RefreshToken): Promise<void>;
  /** Stores a successor token of an existing session. */
  addToken(token: RefreshToken): Promise<void>;
  /**
   * Rotates a token in one atomic statement: it must be unused, not revoked and inside its idle expiry,
   * and its session must belong to `appId`, be active and inside its absolute expiry. Records the
   * successor hash and the IP hash. Returns null when any condition fails, so callers cannot tell why.
   */
  consume(hash: Buffer, appId: string, now: Date, successorHash: Buffer, ipHash: Buffer): Promise<ConsumedToken | null>;
  findTokenState(hash: Buffer): Promise<TokenState | null>;
  /** Records that the session was used (a refresh, normal or grace), in the current unit of work. */
  touch(sessionId: string, now: Date): Promise<void>;
  /** Revokes one session. Idempotent: the first reason and time are kept. */
  revoke(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<void>;
  /** Revokes every active session of an account. Returns how many it revoked. */
  revokeAllForUser(userId: string, reason: SessionRevokedReason, now: Date): Promise<number>;
  /**
   * Revokes every session that is still open, of every account and app (the key-compromise procedure).
   * Sessions already revoked or already past their end are left alone. Returns how many it revoked.
   */
  revokeAll(reason: SessionRevokedReason, now: Date): Promise<number>;
  /**
   * Claims the one-time grace of a rotated, unrevoked token. Returns the hash of its successor the first
   * time, and null every other time (concurrent claims yield exactly one winner).
   */
  claimGrace(hash: Buffer, now: Date): Promise<Buffer | null>;
  /** Revokes a token that was never used. False when it was already used or revoked. */
  revokeToken(hash: Buffer, now: Date): Promise<boolean>;
}

export const SESSION_REPOSITORY = Symbol('SessionRepository');
