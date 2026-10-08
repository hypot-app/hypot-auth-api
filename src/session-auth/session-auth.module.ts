import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AbuseGuard } from '../abuse-protection/application/abuse-guard';
import { AbuseProtectionModule } from '../abuse-protection/abuse-protection.module';
import { ResolveClientUseCase } from '../app-registry/application/resolve-client.use-case';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { noStore } from '../platform/http/no-store.middleware';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { TOKEN_GENERATOR, type TokenGenerator } from '../shared-kernel/token-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_ISSUER, type AccessTokenIssuer } from '../token-lifecycle/domain/access-token';
import { TokenLifecycleModule } from '../token-lifecycle/token-lifecycle.module';
import { PASSWORD_HASHER, type PasswordHasher } from '../user-accounts/domain/password-hasher';
import { USER_REPOSITORY, type UserRepository } from '../user-accounts/domain/user.repository';
import { UserAccountsModule } from '../user-accounts/user-accounts.module';
import { createDummyPasswordHash, DUMMY_PASSWORD_HASH } from './application/dummy-password-hash';
import { LoginUseCase } from './application/login.use-case';
import { SESSION_REPOSITORY } from './domain/session.repository';
import { AuthController } from './http/auth.controller';
import { RefreshTokenSchema } from './infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from './infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from './infrastructure/persistence/typeorm-session.repository';
import { SESSION_CONFIG_PROVIDERS, SESSION_TTLS, type SessionTtls } from './infrastructure/session-config';

/** Use cases are plain classes (no Nest decorators); they are wired with factories here (ADR 2). */
@Module({
  imports: [
    TypeOrmModule.forFeature([SessionSchema, RefreshTokenSchema]),
    AppRegistryModule,
    AbuseProtectionModule,
    UserAccountsModule,
    TokenLifecycleModule,
  ],
  controllers: [AuthController],
  providers: [
    ...SESSION_CONFIG_PROVIDERS,
    TypeOrmSessionRepository,
    { provide: SESSION_REPOSITORY, useExisting: TypeOrmSessionRepository },
    // Hashed once at boot with the real cost, so an unknown email takes as long as a known one.
    { provide: DUMMY_PASSWORD_HASH, inject: [PASSWORD_HASHER], useFactory: createDummyPasswordHash },
    {
      provide: LoginUseCase,
      inject: [
        ResolveClientUseCase,
        AbuseGuard,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        DUMMY_PASSWORD_HASH,
        SESSION_REPOSITORY,
        TOKEN_GENERATOR,
        ACCESS_TOKEN_ISSUER,
        CLOCK,
        UNIT_OF_WORK,
        SESSION_TTLS,
      ],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        abuse: AbuseGuard,
        users: UserRepository,
        hasher: PasswordHasher,
        dummyHash: string,
        sessions: TypeOrmSessionRepository,
        tokens: TokenGenerator,
        accessTokens: AccessTokenIssuer,
        clock: Clock,
        uow: UnitOfWork,
        ttls: SessionTtls,
      ) => new LoginUseCase({ resolveClient, abuse, users, hasher, dummyHash, sessions, tokens, accessTokens, clock, uow, ttls }),
    },
  ],
})
export class SessionAuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route of the controller, answers and errors alike: session-auth routes hand out tokens.
    consumer.apply(noStore).forRoutes(AuthController);
  }
}
