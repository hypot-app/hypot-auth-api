import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { KEY_STORE } from './domain/key-store';
import { JwksController } from './http/jwks.controller';
import { JwkSetKeyStore } from './infrastructure/jwk-set-key-store';

@Module({
  controllers: [JwksController],
  providers: [
    {
      provide: KEY_STORE,
      inject: [APP_CONFIG],
      // Parsed once at boot: an unusable key set stops the app before it listens.
      useFactory: (config: AppConfig) => JwkSetKeyStore.fromJson(config.signingKeysJson),
    },
  ],
  exports: [KEY_STORE],
})
export class TokenLifecycleModule {}
