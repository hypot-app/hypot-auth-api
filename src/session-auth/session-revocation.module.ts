import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { RevokeAccountSessionsUseCase } from './application/revoke-account-sessions.use-case';
import { RevokeAllSessionsUseCase } from './application/revoke-all-sessions.use-case';
import { SESSION_REPOSITORY, type SessionRepository } from './domain/session.repository';
import { RefreshTokenSchema } from './infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from './infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from './infrastructure/persistence/typeorm-session.repository';

/**
 * Session storage and the use cases that only end sessions. It needs no signing key and no HTTP, so the
 * operator CLI (`ops:revoke-all`) can import it without booting the token machinery, and password-management
 * reaches `RevokeAccountSessionsUseCase` through `SessionAuthModule`, which re-exports it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SessionSchema, RefreshTokenSchema])],
  providers: [
    TypeOrmSessionRepository,
    { provide: SESSION_REPOSITORY, useExisting: TypeOrmSessionRepository },
    {
      provide: RevokeAccountSessionsUseCase,
      inject: [SESSION_REPOSITORY, CLOCK],
      useFactory: (sessions: SessionRepository, clock: Clock) => new RevokeAccountSessionsUseCase({ sessions, clock }),
    },
    {
      provide: RevokeAllSessionsUseCase,
      inject: [SESSION_REPOSITORY, CLOCK],
      useFactory: (sessions: SessionRepository, clock: Clock) => new RevokeAllSessionsUseCase({ sessions, clock }),
    },
  ],
  exports: [SESSION_REPOSITORY, RevokeAccountSessionsUseCase, RevokeAllSessionsUseCase],
})
export class SessionRevocationModule {}
