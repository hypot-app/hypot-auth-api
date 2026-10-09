import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startBackgroundJobs } from './background-jobs';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config';
import { configureApp } from './platform/configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Lets Nest stop the outbox poller and both sweepers (and close the DB pool) on SIGTERM.
  app.enableShutdownHooks();
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
  startBackgroundJobs(app);
}

void bootstrap();
