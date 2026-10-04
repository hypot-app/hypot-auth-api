import type { EmailOutbox } from '../../src/transactional-email/domain/email-outbox';
import type { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';

/** Unit-test double for EmailOutbox; no locking (tests run one worker). */
export class InMemoryEmailOutbox implements EmailOutbox {
  readonly emails = new Map<string, OutboxEmail>();

  async save(email: OutboxEmail): Promise<void> {
    this.emails.set(email.id, email);
  }

  async claimNextDue(now: Date): Promise<OutboxEmail | null> {
    const due = [...this.emails.values()]
      .filter((email) => email.status === 'pending' && email.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime());
    return due[0] ?? null;
  }
}
