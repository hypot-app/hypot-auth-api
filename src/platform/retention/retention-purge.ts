/**
 * Deletes data past its retention window (ADR 35). Every method deletes at most `limit` rows older than
 * `cutoff` (strictly) and returns how many it deleted, so a caller can loop until a batch comes back short.
 */
export interface RetentionPurge {
  /** Sessions whose `expires_at` is before `cutoff`, with their refresh tokens. Returns sessions deleted. */
  deleteExpiredSessions(cutoff: Date, limit: number): Promise<number>;
  /** One-time tokens, consumed or not, whose `expires_at` is before `cutoff`. */
  deleteExpiredOneTimeTokens(cutoff: Date, limit: number): Promise<number>;
  /** Outbox rows that are `sent` or `failed` and were created before `cutoff`. Pending rows are never deleted. */
  deleteSettledOutbox(cutoff: Date, limit: number): Promise<number>;
}

export const RETENTION_PURGE = Symbol('RetentionPurge');
