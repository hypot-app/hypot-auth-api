import type { EmailTemplate } from './email-template';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

/** Longest error text kept on a row. Provider errors are untrusted and unbounded. */
const MAX_ERROR_LENGTH = 500;

export interface OutboxEmail {
  readonly id: string;
  readonly appId: string;
  readonly to: string;
  /** A string, not EmailTemplate: a row read back from storage may name an unknown template. */
  readonly template: string;
  /** Raw template inputs (may include a one-time token). Emptied once the email is terminal. */
  readonly payload: Readonly<Record<string, string>>;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
}

const bounded = (error: string): string => error.slice(0, MAX_ERROR_LENGTH);

/** State transitions for a queued email. Each returns a new value; none mutates. */
export const OutboxEmail = {
  queue(input: {
    id: string;
    appId: string;
    to: string;
    template: EmailTemplate;
    payload: Record<string, string>;
    now: Date;
  }): OutboxEmail {
    return {
      id: input.id,
      appId: input.appId,
      to: input.to,
      template: input.template,
      payload: { ...input.payload },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: input.now,
      lastError: null,
      createdAt: input.now,
    };
  },

  /** Delivered. The payload (raw links and tokens) is purged. */
  markSent(email: OutboxEmail): OutboxEmail {
    return { ...email, status: 'sent', payload: {}, attempts: email.attempts + 1, lastError: null };
  },

  /** Delivery failed but may succeed later. */
  markRetry(email: OutboxEmail, error: string, nextAttemptAt: Date): OutboxEmail {
    return { ...email, attempts: email.attempts + 1, lastError: bounded(error), nextAttemptAt };
  },

  /** Gave up. The payload is purged: a dead row must not keep a live token. */
  markFailed(email: OutboxEmail, error: string): OutboxEmail {
    return { ...email, status: 'failed', payload: {}, attempts: email.attempts + 1, lastError: bounded(error) };
  },
};
