import { OutboxEmail } from './outbox-email';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const LATER = new Date('2026-01-01T00:05:00.000Z');

const queued = () =>
  OutboxEmail.queue({
    id: 'id-1',
    appId: 'app-1',
    to: 'ana@example.com',
    template: 'confirmation',
    payload: { token: 'raw-token' },
    now: NOW,
  });

describe('OutboxEmail', () => {
  it('is queued as pending, due immediately, with no attempts', () => {
    expect(queued()).toEqual({
      id: 'id-1',
      appId: 'app-1',
      to: 'ana@example.com',
      template: 'confirmation',
      payload: { token: 'raw-token' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: NOW,
      lastError: null,
      createdAt: NOW,
    });
  });

  it('markSent purges the payload and counts the attempt', () => {
    const sent = OutboxEmail.markSent(queued());
    expect(sent.status).toBe('sent');
    expect(sent.payload).toEqual({});
    expect(sent.attempts).toBe(1);
    expect(sent.lastError).toBeNull();
  });

  it('markRetry keeps the payload, counts the attempt, records the error and reschedules', () => {
    const retry = OutboxEmail.markRetry(queued(), 'timeout', LATER);
    expect(retry.status).toBe('pending');
    expect(retry.payload).toEqual({ token: 'raw-token' });
    expect(retry.attempts).toBe(1);
    expect(retry.lastError).toBe('timeout');
    expect(retry.nextAttemptAt).toEqual(LATER);
  });

  it('markFailed is terminal: it purges the payload and keeps the error', () => {
    const failed = OutboxEmail.markFailed(OutboxEmail.markRetry(queued(), 'timeout', LATER), 'gave up');
    expect(failed.status).toBe('failed');
    expect(failed.payload).toEqual({});
    expect(failed.attempts).toBe(2);
    expect(failed.lastError).toBe('gave up');
  });

  it('bounds the stored error text', () => {
    const retry = OutboxEmail.markRetry(queued(), 'x'.repeat(5000), LATER);
    expect(retry.lastError).toHaveLength(500);
  });
});
