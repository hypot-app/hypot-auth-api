import type { OutboxEmail } from '../../domain/outbox-email';
import type { EmailOutboxRow } from './email-outbox.schema';

export const EmailOutboxMapper = {
  toDomain(row: EmailOutboxRow): OutboxEmail {
    return {
      id: row.id,
      appId: row.app_id,
      to: row.to_address,
      template: row.template,
      payload: { ...row.payload },
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      lastError: row.last_error,
      createdAt: row.created_at,
    };
  },

  toPersistence(email: OutboxEmail): EmailOutboxRow {
    return {
      id: email.id,
      app_id: email.appId,
      to_address: email.to,
      template: email.template,
      payload: { ...email.payload },
      status: email.status,
      attempts: email.attempts,
      next_attempt_at: email.nextAttemptAt,
      last_error: email.lastError,
      created_at: email.createdAt,
    };
  },
};
