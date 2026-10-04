import type { INestApplication } from '@nestjs/common';

export const API_PREFIX = 'api/v1';

/** Routes that stay at the root: liveness, welcome, and RFC 8615 discovery. */
export const UNPREFIXED_ROUTES = ['/', 'health', '.well-known/jwks.json'];

/**
 * Shared bootstrap for main.ts and the e2e app factory (ADR 28), so tests
 * always exercise the production route layout.
 */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
}
