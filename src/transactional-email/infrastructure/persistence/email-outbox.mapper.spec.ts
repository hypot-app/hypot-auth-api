import { OutboxEmail } from '../../domain/outbox-email';
import { EmailOutboxMapper } from './email-outbox.mapper';
import type { EmailOutboxRow } from './email-outbox.schema';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const rowOf = (overrides: Partial<EmailOutboxRow> = {}): EmailOutboxRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  app_id: '22222222-2222-4222-8222-222222222222',
  to_address: 'ana@example.com',
  template: 'password-reset',
  payload: { token: 'raw-token' },
  status: 'failed',
  attempts: 3,
  next_attempt_at: new Date('2026-01-02T00:00:00.000Z'),
  last_error: 'connection refused',
  created_at: NOW,
  ...overrides,
});

describe('EmailOutboxMapper', () => {
  it('maps a row to a domain OutboxEmail', () => {
    const email = EmailOutboxMapper.toDomain(rowOf());
    expect(email).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      appId: '22222222-2222-4222-8222-222222222222',
      to: 'ana@example.com',
      template: 'password-reset',
      payload: { token: 'raw-token' },
      status: 'failed',
      attempts: 3,
      nextAttemptAt: new Date('2026-01-02T00:00:00.000Z'),
      lastError: 'connection refused',
      createdAt: NOW,
    });
  });

  it('round-trips row -> domain -> row, including the null last_error case', () => {
    const failed = rowOf();
    const fresh = rowOf({ status: 'pending', attempts: 0, last_error: null });
    expect(EmailOutboxMapper.toPersistence(EmailOutboxMapper.toDomain(failed))).toEqual(failed);
    expect(EmailOutboxMapper.toPersistence(EmailOutboxMapper.toDomain(fresh))).toEqual(fresh);
  });

  it('round-trips domain -> row -> domain', () => {
    const email = OutboxEmail.queue({
      id: '33333333-3333-4333-8333-333333333333',
      appId: '22222222-2222-4222-8222-222222222222',
      to: 'bo@example.com',
      template: 'welcome',
      payload: {},
      now: NOW,
    });
    expect(EmailOutboxMapper.toDomain(EmailOutboxMapper.toPersistence(email))).toEqual(email);
  });

  it('does not share the payload object between row and domain', () => {
    const row = rowOf();
    const email = EmailOutboxMapper.toDomain(row);
    row.payload.token = 'tampered';
    expect(email.payload).toEqual({ token: 'raw-token' });
  });
});
