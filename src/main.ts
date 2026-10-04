import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { APP_CONFIG, type AppConfig } from './platform/config/app-config';
import { configureApp } from './platform/configure-app';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(app.get<AppConfig>(APP_CONFIG).port);
}

void bootstrap();
