import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { ACCESS_TOKEN_ISSUER, ACCESS_TOKEN_VERIFIER } from './domain/access-token';
import { KEY_STORE, type KeyStore } from './domain/key-store';
import { JwksController } from './http/jwks.controller';
import { JoseAccessTokenIssuer } from './infrastructure/jose-access-token-issuer';
import { JoseAccessTokenVerifier } from './infrastructure/jose-access-token-verifier';
import { JwkSetKeyStore } from './infrastructure/jwk-set-key-store';

/** The issuer URL is the public base URL of this service (spec: "the configured issuer"). */
@Module({
  controllers: [JwksController],
  providers: [
    {
      provide: KEY_STORE,
      inject: [APP_CONFIG],
      // Parsed once at boot: an unusable key set stops the app before it listens.
      useFactory: (config: AppConfig) => JwkSetKeyStore.fromJson(config.signingKeysJson),
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
