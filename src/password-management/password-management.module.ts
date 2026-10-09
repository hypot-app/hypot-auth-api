import { Module } from '@nestjs/common';
import { AbuseGuard } from '../abuse-protection/application/abuse-guard';
import { AbuseProtectionModule } from '../abuse-protection/abuse-protection.module';
import { ResolveClientUseCase } from '../app-registry/application/resolve-client.use-case';
import { AppRegistryModule } from '../app-registry/app-registry.module';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { TOKEN_GENERATOR, type TokenGenerator } from '../shared-kernel/token-generator';
import { UNIT_OF_WORK, type UnitOfWork } from '../shared-kernel/unit-of-work';
import { EMAIL_OUTBOX, type EmailOutbox } from '../transactional-email/domain/email-outbox';
import { RevokeAccountSessionsUseCase } from '../session-auth/application/revoke-account-sessions.use-case';
import { SessionRevocationModule } from '../session-auth/session-revocation.module';
import { AuthenticateBearerUseCase } from '../token-lifecycle/application/authenticate-bearer.use-case';
import { BearerAuthModule } from '../token-lifecycle/bearer-auth.module';
import { TransactionalEmailModule } from '../transactional-email/transactional-email.module';
import { ConfirmationIssuer } from '../user-accounts/application/confirmation-issuer';
import { PASSWORD_HASHER, type PasswordHasher } from '../user-accounts/domain/password-hasher';
import { ONE_TIME_TOKEN_REPOSITORY, type OneTimeTokenRepository } from '../user-accounts/domain/one-time-token.repository';
import { USER_REPOSITORY, type UserRepository } from '../user-accounts/domain/user.repository';
import { UserAccountsModule } from '../user-accounts/user-accounts.module';
import { ChangePasswordUseCase } from './application/change-password.use-case';
import { ForgotPasswordUseCase } from './application/forgot-password.use-case';
import { PasswordResetIssuer } from './application/password-reset-issuer';
import { ResetPasswordUseCase } from './application/reset-password.use-case';
import { PasswordController } from './http/password.controller';

/** Use cases are plain classes (no Nest decorators); they are wired with factories here (ADR 2). */
@Module({
  imports: [AbuseProtectionModule, AppRegistryModule, BearerAuthModule, SessionRevocationModule, TransactionalEmailModule, UserAccountsModule],
  controllers: [PasswordController],
  providers: [
    {
      provide: PasswordResetIssuer,
      inject: [TOKEN_GENERATOR, ONE_TIME_TOKEN_REPOSITORY, EMAIL_OUTBOX, CLOCK],
      useFactory: (tokens: TokenGenerator, oneTimeTokens: OneTimeTokenRepository, outbox: EmailOutbox, clock: Clock) =>
        new PasswordResetIssuer({ tokens, oneTimeTokens, outbox, clock }),
    },
    {
      provide: ForgotPasswordUseCase,
      inject: [ResolveClientUseCase, AbuseGuard, USER_REPOSITORY, ConfirmationIssuer, PasswordResetIssuer, UNIT_OF_WORK],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        abuse: AbuseGuard,
        users: UserRepository,
        confirmations: ConfirmationIssuer,
        resets: PasswordResetIssuer,
        uow: UnitOfWork,
      ) => new ForgotPasswordUseCase({ resolveClient, abuse, users, confirmations, resets, uow }),
    },
    {
      provide: ResetPasswordUseCase,
      inject: [ResolveClientUseCase, AbuseGuard, ONE_TIME_TOKEN_REPOSITORY, USER_REPOSITORY, PASSWORD_HASHER, RevokeAccountSessionsUseCase, CLOCK, UNIT_OF_WORK],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        abuse: AbuseGuard,
        oneTimeTokens: OneTimeTokenRepository,
        users: UserRepository,
        hasher: PasswordHasher,
        sessions: RevokeAccountSessionsUseCase,
        clock: Clock,
        uow: UnitOfWork,
      ) => new ResetPasswordUseCase({ resolveClient, abuse, oneTimeTokens, users, hasher, sessions, clock, uow }),
    },
    {
      provide: ChangePasswordUseCase,
      inject: [
        ResolveClientUseCase,
        AbuseGuard,
        AuthenticateBearerUseCase,
        USER_REPOSITORY,
        PASSWORD_HASHER,
        RevokeAccountSessionsUseCase,
        EMAIL_OUTBOX,
        CLOCK,
        UNIT_OF_WORK,
      ],
      useFactory: (
        resolveClient: ResolveClientUseCase,
        abuse: AbuseGuard,
        authenticate: AuthenticateBearerUseCase,
        users: UserRepository,
        hasher: PasswordHasher,
        sessions: RevokeAccountSessionsUseCase,
        outbox: EmailOutbox,
        clock: Clock,
        uow: UnitOfWork,
      ) => new ChangePasswordUseCase({ resolveClient, abuse, authenticate, users, hasher, sessions, outbox, clock, uow }),
    },
  ],
})
export class PasswordManagementModule {}
