import type { AppRepository } from '../../app-registry/domain/app.repository';
import type { Clock } from '../../shared-kernel/clock';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
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
  uow: UnitOfWork;
  clock: Clock;
  links: EmailLinks;
  /** MAIL_FROM: used when the app has no `email_from`. */
  defaultFrom: string;
  logger: WorkerLogger;
  maxAttempts: number;
}

/**
 * Delivers queued emails. Each email is handled in its own transaction: the row is
 * locked (SKIP LOCKED, so parallel workers never take the same one), delivered, and
 * updated before the lock is released. Delivery is at-least-once: a crash between
 * the provider accepting a message and the commit sends it again.
 */
export class OutboxWorker {
  constructor(private readonly deps: OutboxWorkerDeps) {}

  /** Handles the oldest due email. Returns false when nothing was due. */
  processNext(): Promise<boolean> {
    return this.deps.uow.run(async () => {
      const email = await this.deps.outbox.claimNextDue(this.deps.clock.now());
      if (email === null) return false;
      await this.deliver(email);
      return true;
    });
  }

  /** Handles due emails until none is left or `limit` is reached. Returns how many were handled. */
  async drain(limit: number): Promise<number> {
    let handled = 0;
    while (handled < limit && (await this.processNext())) handled++;
    return handled;
  }

  private async deliver(email: OutboxEmail): Promise<void> {
    const { apps, links, renderer, sender, outbox } = this.deps;
    const app = await apps.findById(email.appId);
    if (app === null) return this.failPermanently(email, 'app not found');

    const variables = buildEmailVariables({ template: email.template, payload: email.payload, app, links });
    if (!variables.ok) return this.failPermanently(email, variables.error);

    try {
      const rendered = await renderer.render({
        template: email.template,
        clientId: app.clientId,
        variables: variables.value,
      });
      await sender.send({ to: email.to, from: app.emailFrom ?? this.deps.defaultFrom, ...rendered });
    } catch (error) {
      return this.retryOrGiveUp(email, error);
    }
    await outbox.save(OutboxEmail.markSent(email));
  }

  private async failPermanently(email: OutboxEmail, reason: string): Promise<void> {
    this.deps.logger.error(`email ${email.id} (${email.template}) failed permanently: ${reason}`);
    await this.deps.outbox.save(OutboxEmail.markFailed(email, reason));
  }

  private async retryOrGiveUp(email: OutboxEmail, error: unknown): Promise<void> {
    const { logger, outbox, clock, maxAttempts } = this.deps;
    const attempt = email.attempts + 1;
    const reason = describeError(error, email);
    const prefix = `email ${email.id} (${email.template}) attempt ${attempt}/${maxAttempts} failed`;
    if (attempt >= maxAttempts) {
      logger.error(`${prefix}, giving up: ${reason}`);
      await outbox.save(OutboxEmail.markFailed(email, reason));
      return;
    }
    logger.warn(`${prefix}, will retry: ${reason}`);
    const nextAttemptAt = new Date(clock.now().getTime() + retryDelayMs(attempt));
    await outbox.save(OutboxEmail.markRetry(email, reason, nextAttemptAt));
  }
}

/**
 * Provider errors are untrusted text that may echo the message it was given (the
 * recipient, a link with a live token). Values from the email are masked before the
 * text is stored or logged, and the text is bounded. Only Error instances are described;
 * anything else is opaque.
 */
function describeError(error: unknown, email: OutboxEmail): string {
  if (!(error instanceof Error)) return 'unknown error';
  const secrets = [email.to, ...Object.values(email.payload)].filter((value) => value.length > 0);
  const masked = secrets.reduce(
    (text, secret) => text.split(secret).join('[redacted]'),
    `${error.name}: ${error.message}`,
  );
  return masked.slice(0, MAX_ERROR_LENGTH);
}
