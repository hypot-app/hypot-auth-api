import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { API_PREFIX } from '../shared-kernel/api-prefix';
import { APP_CONFIG, type AppConfig } from './config/app-config';

/** Routes that stay at the root: liveness, welcome, and RFC 8615 discovery. */
export const UNPREFIXED_ROUTES = ['/', 'health', '.well-known/jwks.json'];

/**
 * Shared bootstrap for main.ts and the e2e app factory (ADR 28), so tests
 * always exercise the production route layout.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  // Never `true` (config rejects it): X-Forwarded-For is trusted only from configured proxies (ADR 37).
  (app as NestExpressApplication).set('trust proxy', app.get<AppConfig>(APP_CONFIG).trustProxy);
}
