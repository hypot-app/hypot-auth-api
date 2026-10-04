import type { OutboxEmail } from './outbox-email';

/** Port: the email queue. Implementations join the current unit of work. */
export interface EmailOutbox {
  /** Inserts a new email or updates an existing one (matched by id). */
  save(email: OutboxEmail): Promise<void>;
  /**
   * Locks and returns the oldest pending email due at `now`, skipping rows another
   * worker already holds. The lock lasts until the surrounding unit of work ends,
   * so callers must run this inside `UnitOfWork.run`.
   */
  claimNextDue(now: Date): Promise<OutboxEmail | null>;
}

export const EMAIL_OUTBOX = Symbol('EmailOutbox');
