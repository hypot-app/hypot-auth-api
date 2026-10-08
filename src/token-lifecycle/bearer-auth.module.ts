import { Module } from '@nestjs/common';
import { ResolveClientUseCase } from '../app-registry/application/resolve-client.use-case';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { AuthenticateBearerUseCase } from './application/authenticate-bearer.use-case';
import { ACCESS_TOKEN_VERIFIER, type AccessTokenVerifier } from './domain/access-token';
import { TokenLifecycleModule } from './token-lifecycle.module';

/**
 * Bearer authentication for endpoints that take an access token (`/me`, password change). It is a module
 * of its own so `TokenLifecycleModule` stays free of the app registry and boots with keys alone.
 */
@Module({
  imports: [AppRegistryModule, TokenLifecycleModule],
  providers: [
    {
      provide: AuthenticateBearerUseCase,
      inject: [ResolveClientUseCase, ACCESS_TOKEN_VERIFIER],
      useFactory: (resolveClient: ResolveClientUseCase, verifier: AccessTokenVerifier) =>
        new AuthenticateBearerUseCase({ resolveClient, verifier }),
    },
  ],
  exports: [AuthenticateBearerUseCase],
})
export class BearerAuthModule {}
