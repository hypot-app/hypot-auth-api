import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AbuseCounterSweeper } from './abuse-protection/application/abuse-counter-sweeper';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config';
import { configureApp } from './platform/configure-app';
import { OutboxPoller } from './transactional-email/infrastructure/outbox-poller';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Lets Nest stop the outbox poller and the counter sweeper (and close the DB pool) on SIGTERM.
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
  app.get(OutboxPoller).start();
  app.get(AbuseCounterSweeper).start();
}

void bootstrap();
