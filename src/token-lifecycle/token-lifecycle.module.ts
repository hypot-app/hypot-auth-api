import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_VERIFIER } from './domain/access-token';
import { KEY_STORE, type KeyStore } from './domain/key-store';
import { JwksController } from './http/jwks.controller';
import { JoseAccessTokenIssuer } from './infrastructure/jose-access-token-issuer';
import { JoseAccessTokenVerifier } from './infrastructure/jose-access-token-verifier';
import { JwkSetKeyStore } from './infrastructure/jwk-set-key-store';
import { SIGNING_KEYS_SOURCE, signingKeysFromEnv, type SigningKeysSource } from './infrastructure/signing-keys-source';

/** The issuer URL is the public base URL of this service (spec: "the configured issuer"). */
@Module({
  controllers: [JwksController],
  providers: [
    // Only this module reads the signing key variables; the CLI never loads it (W2).
    { provide: SIGNING_KEYS_SOURCE, useValue: (() => signingKeysFromEnv(process.env)) satisfies SigningKeysSource },
    {
      provide: KEY_STORE,
      inject: [SIGNING_KEYS_SOURCE, CLOCK],
      // Parsed once at boot: an unusable key set stops the app before it listens.
      useFactory: (source: SigningKeysSource, clock: Clock) => JwkSetKeyStore.fromJson(source(), { clock }),
    },
    {
      provide: ACCESS_TOKEN_ISSUER,
      inject: [KEY_STORE, CLOCK, APP_CONFIG],
      useFactory: (keyStore: KeyStore, clock: Clock, config: AppConfig) =>
        new JoseAccessTokenIssuer({ keyStore, clock, issuer: config.authPublicBaseUrl }),
    },
    {
      provide: ACCESS_TOKEN_VERIFIER,
      inject: [KEY_STORE, CLOCK, APP_CONFIG],
      useFactory: (keyStore: KeyStore, clock: Clock, config: AppConfig) =>
        new JoseAccessTokenVerifier({ keyStore, clock, issuer: config.authPublicBaseUrl }),
    },
  ],
  exports: [KEY_STORE, ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_VERIFIER],
})
export class TokenLifecycleModule {}
