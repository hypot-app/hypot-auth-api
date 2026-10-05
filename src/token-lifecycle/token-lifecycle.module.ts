import { Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { KEY_STORE } from './domain/key-store';
import { JwksController } from './http/jwks.controller';
import { JwkSetKeyStore } from './infrastructure/jwk-set-key-store';
import { SIGNING_KEYS_SOURCE, signingKeysFromEnv, type SigningKeysSource } from './infrastructure/signing-keys-source';

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
  ],
  exports: [KEY_STORE],
})
export class TokenLifecycleModule {}
