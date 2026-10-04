import type { EmailMessage, EmailSender } from '../../src/transactional-email/domain/email-sender';

/** In-memory EmailSender for unit and e2e tests (ADR 25): captures messages, can be told to fail. */
export class FakeEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  failWith: unknown = null;

  async send(message: EmailMessage): Promise<void> {
    if (this.failWith !== null) throw this.failWith;
    this.sent.push(message);
  }
}
