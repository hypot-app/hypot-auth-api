import { EmailOutboxMapper } from './email-outbox.mapper';
import type { EmailOutboxRow } from './email-outbox.schema';

const row: EmailOutboxRow = {
  id: '11111111-1111-4111-8111-111111111111',
  app_id: '22222222-2222-4222-8222-222222222222',
  to_address: 'ana@example.com',
  template: 'password-reset',
  payload: { token: 'raw-token' },
  status: 'failed',
  attempts: 3,
  next_attempt_at: new Date('2026-01-02T00:00:00.000Z'),
  last_error: 'connection refused',
  locked_until: new Date('2026-01-01T00:02:00.000Z'),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('EmailOutboxMapper', () => {
  it('maps every column to the domain value and back, without sharing the payload object', () => {
    const email = EmailOutboxMapper.toDomain(row);
    expect(email).toEqual({
      id: row.id,
      appId: row.app_id,
      to: 'ana@example.com',
      template: 'password-reset',
      payload: { token: 'raw-token' },
      status: 'failed',
      attempts: 3,
      nextAttemptAt: row.next_attempt_at,
      lastError: 'connection refused',
      lockedUntil: row.locked_until,
      createdAt: row.created_at,
    });
    expect(email.payload).not.toBe(row.payload);
    expect(EmailOutboxMapper.toPersistence(email)).toEqual(row);
  });
});
