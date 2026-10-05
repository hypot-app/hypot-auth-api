import type { AppRepository } from '../../app-registry/domain/app.repository';
import type { Clock } from '../../shared-kernel/clock';
import type { EmailOutbox } from '../domain/email-outbox';
import type { EmailSender } from '../domain/email-sender';
import { MAX_ERROR_LENGTH, OutboxEmail } from '../domain/outbox-email';
import type { TemplateRenderer } from '../domain/template-renderer';
import type { EmailLinks } from './email-links';
import { buildEmailVariables } from './email-variables';

export interface WorkerLogger {
  warn(message: string): void;
  error(message: string): void;
}

/** Overall budget for rendering and sending one email. */
export const SEND_DEADLINE_MS = 60_000;
/** How long a claim lasts. Longer than the deadline, so a live worker always finishes first. */
export const LEASE_MS = 120_000;

const FIRST_RETRY_DELAY_MS = 30_000;
const MAX_RETRY_DELAY_MS = 3_600_000;

/** Exponential backoff: 30 s after the first failure, doubling, capped at one hour. */
export function retryDelayMs(attempt: number): number {
  return Math.min(FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

export interface OutboxWorkerDeps {
  outbox: EmailOutbox;
  apps: AppRepository;
  sender: EmailSender;
  renderer: TemplateRenderer;
  clock: Clock;
  links: EmailLinks;
  /** MAIL_FROM: used when the app has no `email_from`. */
  defaultFrom: string;
  logger: WorkerLogger;
  maxAttempts: number;
  /** Defaults to SEND_DEADLINE_MS; tests shorten it. */
  sendDeadlineMs?: number;
}

/**
 * Delivers queued emails. A worker claims one row under a lease (one short statement,
 * SKIP LOCKED, so parallel workers never take the same one), sends it outside any
 * transaction under an overall deadline, then stores the outcome in another short
 * statement fenced on the lease. Delivery is at-least-once: a crash, or a send that
 * outlives its lease, can deliver the email again.
 */
export class OutboxWorker {
  constructor(private readonly deps: OutboxWorkerDeps) {}

  /** Handles the oldest due email. Returns false when nothing was due. */
  async processNext(): Promise<boolean> {
    const { outbox, clock, logger } = this.deps;
    const email = await outbox.claimNextDue(clock.now(), LEASE_MS);
    if (email === null) return false;
    const outcome = await this.deliver(email);
    if (!(await outbox.complete(outcome))) {
      logger.warn(`email ${email.id} (${email.template}) lease lost before the outcome was stored, outcome discarded`);
    }
    return true;
  }

  /** Handles due emails until none is left or `limit` is reached. Returns how many were handled. */
  async drain(limit: number): Promise<number> {
    let handled = 0;
    while (handled < limit && (await this.processNext())) handled++;
    return handled;
  }

  /** Sends the email and returns its next state. Never stores anything itself. */
  private async deliver(email: OutboxEmail): Promise<OutboxEmail> {
    const { apps, links, renderer, sender } = this.deps;
    const app = await apps.findById(email.appId);
    if (app === null) return this.failPermanently(email, 'app not found');

    const variables = buildEmailVariables({ template: email.template, payload: email.payload, app, links });
    if (!variables.ok) return this.failPermanently(email, variables.error);

    try {
      await withDeadline(this.deps.sendDeadlineMs ?? SEND_DEADLINE_MS, async () => {
        const rendered = await renderer.render({
          template: email.template,
          clientId: app.clientId,
          variables: variables.value,
        });
        await sender.send({ to: email.to, from: app.emailFrom ?? this.deps.defaultFrom, ...rendered });
      });
    } catch (error) {
      return this.retryOrGiveUp(email, error);
    }
    return OutboxEmail.markSent(email);
  }

  private failPermanently(email: OutboxEmail, reason: string): OutboxEmail {
    this.deps.logger.error(`email ${email.id} (${email.template}) failed permanently: ${reason}`);
    return OutboxEmail.markFailed(email, reason);
  }

  private retryOrGiveUp(email: OutboxEmail, error: unknown): OutboxEmail {
    const { logger, clock, maxAttempts } = this.deps;
    const attempt = email.attempts + 1;
    const reason = describeError(error, email);
    const prefix = `email ${email.id} (${email.template}) attempt ${attempt}/${maxAttempts} failed`;
    if (attempt >= maxAttempts) {
      logger.error(`${prefix}, giving up: ${reason}`);
      return OutboxEmail.markFailed(email, reason);
    }
    logger.warn(`${prefix}, will retry: ${reason}`);
    const nextAttemptAt = new Date(clock.now().getTime() + retryDelayMs(attempt));
    return OutboxEmail.markRetry(email, reason, nextAttemptAt);
  }
}

/**
 * Rejects when `work` takes longer than `ms`. The work itself is not cancelled (the
 * sender port has no abort signal): it is abandoned, and nodemailer's own socket
 * timeouts end it. If it still delivers, that is the accepted at-least-once duplicate.
 */
async function withDeadline(ms: number, work: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`send exceeded the ${ms} ms deadline`)), ms);
  });
  try {
    await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Provider errors are untrusted text that may echo the message it was given (the
 * recipient, a link with a live token). Values from the email are masked before the
 * text is stored or logged, and the text is bounded. Only Error instances are described;
 * anything else is opaque.
 */
function describeError(error: unknown, email: OutboxEmail): string {
  if (!(error instanceof Error)) return 'unknown error';
  const secrets = [email.to, ...Object.values(email.payload)].filter((value) => value.length > 0);
  // Case-insensitive: providers often echo a recipient normalized to another case.
  const masked = secrets.reduce(
    (text, secret) => text.replace(new RegExp(escapeRegExp(secret), 'gi'), '[redacted]'),
    `${error.name}: ${error.message}`,
  );
  return masked.slice(0, MAX_ERROR_LENGTH);
}
