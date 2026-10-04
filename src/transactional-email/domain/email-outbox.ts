import type { OutboxEmail } from './outbox-email';

/** Port: the email queue. Implementations join the current unit of work. */
export interface EmailOutbox {
  /** Inserts a new email or updates an existing one (matched by id). Used to enqueue. */
  save(email: OutboxEmail): Promise<void>;
  /**
   * Leases the oldest pending email due at `now` for `leaseMs` and returns it with
   * `lockedUntil` set. Rows another worker leases (and whose lease has not expired)
   * are skipped. One short statement: nothing stays locked while the caller works.
   */
  claimNextDue(now: Date, leaseMs: number): Promise<OutboxEmail | null>;
  /**
   * Stores the outcome of a claimed email and releases the lease. Fenced on the lease
   * the email was claimed under: returns false, changing nothing, when that lease is no
   * longer the row's (it expired and another worker took the row).
   */
  complete(email: OutboxEmail): Promise<boolean>;
}

export const EMAIL_OUTBOX = Symbol('EmailOutbox');
