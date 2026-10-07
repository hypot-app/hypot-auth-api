import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { DEFAULT_POLICIES } from '../../src/abuse-protection/domain/policy';
import { APP_CONFIG, type AppConfig } from '../../src/platform/config/app-config';
import { configureApp } from '../../src/platform/configure-app';
import { generateKeySet } from '../../src/token-lifecycle/infrastructure/signing-key-generator';
import { SIGNING_KEYS_SOURCE } from '../../src/token-lifecycle/infrastructure/signing-keys-source';

export interface TestAppOptions {
  /** Connection URL of the Testcontainers database the app must use. */
  databaseUrl: string;
  /** Extra controllers to register, for probing routing before a real route exists. */
  controllers?: Type<unknown>[];
  config?: Partial<AppConfig>;
  /** Signing key set JSON. Defaults to one freshly generated active key; private keys never live in the repository. */
  signingKeysJson?: string;
}

export function buildTestConfig(options: Pick<TestAppOptions, 'databaseUrl' | 'config'>): AppConfig {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    databaseUrl: options.databaseUrl,
    authPublicBaseUrl: 'http://localhost:3000',
    smtp: { host: 'localhost', port: 1025, secure: false, auth: undefined },
    mailFrom: 'no-reply@example.test',
    trustProxy: false,
    abusePolicies: DEFAULT_POLICIES,
    ...options.config,
  };
}

/**
 * Builds the app exactly like main.ts does: same module, same configureApp.
 * Tests therefore hit the production route layout (ADR 28).
 */
export async function createTestApp(options: TestAppOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(APP_CONFIG)
    .useValue(buildTestConfig(options))
    .overrideProvider(SIGNING_KEYS_SOURCE)
    .useValue(() => options.signingKeysJson ?? JSON.stringify(generateKeySet({ next: false })))
    .compile();

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  return app;
}
