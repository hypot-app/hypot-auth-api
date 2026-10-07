import { Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { AbuseCounterSweeper } from './application/abuse-counter-sweeper';
import { AbuseGuard } from './application/abuse-guard';
import type { PolicyTable } from './domain/policy';
import { ABUSE_COUNTER_STORE } from './domain/abuse-counter.store';
import { AbuseExceptionFilter } from './http/abuse-exception.filter';
import { ABUSE_CONFIG_PROVIDERS, ABUSE_POLICIES } from './infrastructure/abuse-config';
import { AbuseCounterSchema } from './infrastructure/persistence/abuse-counter.schema';
import { PostgresAbuseCounterStore } from './infrastructure/persistence/postgres-abuse-counter.store';

/**
 * Rate limits and login lockout. Other modules inject `AbuseGuard` and call it first in their use
 * cases. The sweeper only runs when main.ts starts it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AbuseCounterSchema])],
  providers: [
    ...ABUSE_CONFIG_PROVIDERS,
    PostgresAbuseCounterStore,
    { provide: ABUSE_COUNTER_STORE, useExisting: PostgresAbuseCounterStore },
    {
      provide: AbuseGuard,
      inject: [ABUSE_COUNTER_STORE, ABUSE_POLICIES, CLOCK],
      useFactory: (store: PostgresAbuseCounterStore, policies: PolicyTable, clock: Clock) =>
        new AbuseGuard({ store, policies, clock }),
    },
    {
      provide: AbuseCounterSweeper,
      inject: [PostgresAbuseCounterStore, CLOCK],
      useFactory: (purge: PostgresAbuseCounterStore, clock: Clock) =>
        new AbuseCounterSweeper({ purge, clock, logger: new Logger('AbuseCounterSweeper') }),
    },
    {
      provide: APP_FILTER,
      inject: [CLOCK],
      useFactory: (clock: Clock) => new AbuseExceptionFilter(clock, new Logger('AbuseExceptionFilter')),
    },
  ],
  exports: [AbuseGuard, AbuseCounterSweeper],
})
export class AbuseProtectionModule {}
