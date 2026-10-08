import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResolveClientUseCase } from '../app-registry/application/resolve-client.use-case';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { noStore } from '../platform/http/no-store.middleware';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { TOKEN_GENERATOR, type TokenGenerator } from '../shared-kernel/token-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared-kernel/unit-of-work';
import { EMAIL_OUTBOX, type EmailOutbox } from '../transactional-email/domain/email-outbox';
import { AuthenticateBearerUseCase } from '../token-lifecycle/application/authenticate-bearer.use-case';
import { BearerAuthModule } from '../token-lifecycle/bearer-auth.module';
import { TransactionalEmailModule } from '../transactional-email/transactional-email.module';
import { ConfirmEmailUseCase } from './application/confirm-email.use-case';
import { ConfirmationIssuer } from './application/confirmation-issuer';
import { GetProfileUseCase } from './application/get-profile.use-case';
import { ResendConfirmationUseCase } from './application/resend-confirmation.use-case';
import { SignupUseCase } from './application/signup.use-case';
import { ONE_TIME_TOKEN_REPOSITORY, type OneTimeTokenRepository } from './domain/one-time-token.repository';
import { PASSWORD_HASHER, type PasswordHasher } from './domain/password-hasher';
import { USER_REPOSITORY, type UserRepository } from './domain/user.repository';
import { AccountsController } from './http/accounts.controller';
import { MeController } from './http/me.controller';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { OneTimeTokenSchema } from './infrastructure/persistence/one-time-token.schema';
import { TypeOrmOneTimeTokenRepository } from './infrastructure/persistence/typeorm-one-time-token.repository';
import { TypeOrmUserRepository } from './infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from './infrastructure/persistence/user.schema';

/** Use cases are plain classes (no Nest decorators); they are wired with factories here (ADR 2). */
@Module({
  imports: [TypeOrmModule.forFeature([UserSchema, OneTimeTokenSchema]), AppRegistryModule, TransactionalEmailModule, BearerAuthModule],
  controllers: [AccountsController, MeController],
  providers: [
    TypeOrmUserRepository,
    { provide: USER_REPOSITORY, useExisting: TypeOrmUserRepository },
    TypeOrmOneTimeTokenRepository,
    { provide: ONE_TIME_TOKEN_REPOSITORY, useExisting: TypeOrmOneTimeTokenRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    {
      provide: ConfirmationIssuer,
      inject: [TOKEN_GENERATOR, ONE_TIME_TOKEN_REPOSITORY, EMAIL_OUTBOX, CLOCK],
      useFactory: (tokens: TokenGenerator, oneTimeTokens: OneTimeTokenRepository, outbox: EmailOutbox, clock: Clock) =>
        new ConfirmationIssuer({ tokens, oneTimeTokens, outbox, clock }),
    },
    {
      provide: SignupUseCase,
      inject: [ResolveClientUseCase, USER_REPOSITORY, PASSWORD_HASHER, ConfirmationIssuer, EMAIL_OUTBOX, CLOCK, UNIT_OF_WORK],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        users: UserRepository,
        hasher: PasswordHasher,
        confirmations: ConfirmationIssuer,
        outbox: EmailOutbox,
        clock: Clock,
        uow: UnitOfWork,
      ) => new SignupUseCase({ resolveClient, users, hasher, confirmations, outbox, clock, uow }),
    },
    {
      provide: ConfirmEmailUseCase,
      inject: [ONE_TIME_TOKEN_REPOSITORY, USER_REPOSITORY, EMAIL_OUTBOX, CLOCK, UNIT_OF_WORK],
      useFactory: (
        oneTimeTokens: OneTimeTokenRepository,
        users: UserRepository,
        outbox: EmailOutbox,
        clock: Clock,
        uow: UnitOfWork,
      ) => new ConfirmEmailUseCase({ oneTimeTokens, users, outbox, clock, uow }),
    },
    {
      provide: ResendConfirmationUseCase,
      inject: [ResolveClientUseCase, USER_REPOSITORY, ConfirmationIssuer, UNIT_OF_WORK],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        users: UserRepository,
        confirmations: ConfirmationIssuer,
        uow: UnitOfWork,
      ) => new ResendConfirmationUseCase({ resolveClient, users, confirmations, uow }),
    },
    {
      provide: GetProfileUseCase,
      inject: [AuthenticateBearerUseCase, USER_REPOSITORY],
      useFactory: (authenticate: AuthenticateBearerUseCase, users: UserRepository) =>
        new GetProfileUseCase({ authenticate, users }),
    },
  ],
  // The ports session-auth needs (ADR 42): modules never reach into each other's infrastructure.
  exports: [USER_REPOSITORY, PASSWORD_HASHER],
})
export class UserAccountsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // The profile is private to the caller: no shared cache may keep it, success or error alike.
    consumer.apply(noStore).forRoutes(MeController);
  }
}
