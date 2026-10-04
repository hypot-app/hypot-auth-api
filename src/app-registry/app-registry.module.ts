import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { TOKEN_GENERATOR, type TokenGenerator } from '../shared-kernel/token-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared-kernel/unit-of-work';
import { ID_GENERATOR, type IdGenerator } from './application/id-generator';
import { DeactivateAppUseCase } from './application/deactivate-app.use-case';
import { IsOriginAllowedUseCase } from './application/is-origin-allowed.use-case';
import { RegisterAppUseCase } from './application/register-app.use-case';
import { ResolveClientUseCase } from './application/resolve-client.use-case';
import { UpdateAppUseCase } from './application/update-app.use-case';
import { APP_REPOSITORY, type AppRepository } from './domain/app.repository';
import { AppCorsMiddleware } from './http/app-cors.middleware';
import { CryptoIdGenerator } from './infrastructure/crypto-id-generator';
import { AppSchema } from './infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from './infrastructure/persistence/typeorm-app.repository';

/** How long a CORS origin decision is cached. Deactivating an app takes at most this long to apply. */
const CORS_ORIGIN_CACHE_TTL_MS = 30_000;

/** Use cases are plain classes (no Nest decorators); they are wired with factories here (ADR 2). */
@Module({
  imports: [TypeOrmModule.forFeature([AppSchema])],
  providers: [
    TypeOrmAppRepository,
    { provide: APP_REPOSITORY, useExisting: TypeOrmAppRepository },
    { provide: ID_GENERATOR, useClass: CryptoIdGenerator },
    {
      provide: RegisterAppUseCase,
      inject: [APP_REPOSITORY, TOKEN_GENERATOR, CLOCK, ID_GENERATOR, UNIT_OF_WORK],
      useFactory: (apps: AppRepository, tokens: TokenGenerator, clock: Clock, ids: IdGenerator, uow: UnitOfWork) =>
        new RegisterAppUseCase({ apps, tokens, clock, ids, uow }),
    },
    {
      provide: UpdateAppUseCase,
      inject: [APP_REPOSITORY, CLOCK, UNIT_OF_WORK],
      useFactory: (apps: AppRepository, clock: Clock, uow: UnitOfWork) => new UpdateAppUseCase({ apps, clock, uow }),
    },
    {
      provide: DeactivateAppUseCase,
      inject: [APP_REPOSITORY, CLOCK, UNIT_OF_WORK],
      useFactory: (apps: AppRepository, clock: Clock, uow: UnitOfWork) =>
        new DeactivateAppUseCase({ apps, clock, uow }),
    },
    {
      provide: IsOriginAllowedUseCase,
      inject: [APP_REPOSITORY, CLOCK],
      useFactory: (apps: AppRepository, clock: Clock) =>
        new IsOriginAllowedUseCase({ apps, clock, ttlMs: CORS_ORIGIN_CACHE_TTL_MS }),
    },
    {
      provide: ResolveClientUseCase,
      inject: [APP_REPOSITORY],
      useFactory: (apps: AppRepository) => new ResolveClientUseCase(apps),
    },
  ],
  exports: [APP_REPOSITORY, RegisterAppUseCase, UpdateAppUseCase, DeactivateAppUseCase, ResolveClientUseCase, IsOriginAllowedUseCase],
})
export class AppRegistryModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Paths get the global `api/v1` prefix. Only the browser-facing API routes need CORS.
    consumer.apply(AppCorsMiddleware).forRoutes('oauth/token', 'oauth/revoke', 'me');
  }
}
