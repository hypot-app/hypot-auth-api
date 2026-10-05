import { join } from 'node:path';
import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { APP_REPOSITORY, type AppRepository } from '../app-registry/domain/app.repository';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { OutboxWorker } from './application/outbox-worker';
import { EMAIL_OUTBOX, type EmailOutbox } from './domain/email-outbox';
import { EMAIL_SENDER, type EmailSender } from './domain/email-sender';
import { TEMPLATE_RENDERER, type TemplateRenderer } from './domain/template-renderer';
import { HandlebarsTemplateRenderer } from './infrastructure/handlebars-template-renderer';
import { OutboxPoller } from './infrastructure/outbox-poller';
import { EmailOutboxSchema } from './infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from './infrastructure/persistence/typeorm-email-outbox';
import { SmtpEmailSender } from './infrastructure/smtp-email-sender';

/** Failed deliveries are retried with backoff this many times in total (see retryDelayMs). */
const MAX_DELIVERY_ATTEMPTS = 8;

/**
 * The outbox, its worker and the SMTP adapter. Other modules enqueue through the
 * `EMAIL_OUTBOX` port inside their own unit of work. The worker only runs when
 * main.ts starts the poller.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EmailOutboxSchema]), AppRegistryModule],
  providers: [
    TypeOrmEmailOutbox,
    { provide: EMAIL_OUTBOX, useExisting: TypeOrmEmailOutbox },
    {
      provide: EMAIL_SENDER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SmtpEmailSender(config.smtp),
    },
    // Templates are .hbs files next to this module; the build copies them into dist.
    { provide: TEMPLATE_RENDERER, useValue: new HandlebarsTemplateRenderer(join(__dirname, 'templates')) },
    {
      provide: OutboxWorker,
      inject: [EMAIL_OUTBOX, APP_REPOSITORY, EMAIL_SENDER, TEMPLATE_RENDERER, CLOCK, APP_CONFIG],
      useFactory: (
        outbox: EmailOutbox,
        apps: AppRepository,
        sender: EmailSender,
        renderer: TemplateRenderer,
        clock: Clock,
        config: AppConfig,
      ) =>
        new OutboxWorker({
          outbox,
          apps,
          sender,
          renderer,
          clock,
          defaultFrom: config.mailFrom,
          logger: new Logger('EmailOutbox'),
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        }),
    },
    {
      provide: OutboxPoller,
      inject: [OutboxWorker],
      useFactory: (worker: OutboxWorker) => new OutboxPoller(worker, new Logger('EmailOutbox')),
    },
  ],
  exports: [EMAIL_OUTBOX, OutboxWorker, OutboxPoller],
})
export class TransactionalEmailModule {}
