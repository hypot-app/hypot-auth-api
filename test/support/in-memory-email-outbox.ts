import type { EmailOutbox } from '../../src/transactional-email/domain/email-outbox';
import type { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';

/** Unit-test double for EmailOutbox with the same lease and fence rules as the SQL one. */
export class InMemoryEmailOutbox implements EmailOutbox {
  readonly emails = new Map<string, OutboxEmail>();

  async save(email: OutboxEmail): Promise<void> {
    this.emails.set(email.id, email);
  }

  async claimNextDue(now: Date, leaseMs: number): Promise<OutboxEmail | null> {
    const due = [...this.emails.values()]
      .filter(
        (email) =>
          email.status === 'pending' &&
          email.nextAttemptAt <= now &&
          (email.lockedUntil === null || email.lockedUntil < now),
      )
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
    const next = due[0];
    if (next === undefined) return null;
    const claimed = { ...next, lockedUntil: new Date(now.getTime() + leaseMs) };
    this.emails.set(claimed.id, claimed);
    return claimed;
  }

  async complete(email: OutboxEmail): Promise<boolean> {
    const stored = this.emails.get(email.id);
    if (stored === undefined || stored.lockedUntil === null || stored.lockedUntil.getTime() !== email.lockedUntil?.getTime()) {
      return false;
    }
    this.emails.set(email.id, { ...email, lockedUntil: null });
    return true;
  }
}
