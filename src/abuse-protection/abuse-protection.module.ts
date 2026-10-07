import { Logger, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { CLOCK, type Clock } from '../shared-kernel/clock';
import { AbuseCounterSweeper } from './application/abuse-counter-sweeper';
import { AbuseGuard } from './application/abuse-guard';
import { ABUSE_COUNTER_STORE } from './domain/abuse-counter.store';
import { AbuseExceptionFilter } from './http/abuse-exception.filter';
import { AbuseCounterSchema } from './infrastructure/persistence/abuse-counter.schema';
import { PostgresAbuseCounterStore } from './infrastructure/persistence/postgres-abuse-counter.store';

/**
 * Rate limits and login lockout. Other modules inject `AbuseGuard` and call it first in their use
 * cases. The sweeper only runs when main.ts starts it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AbuseCounterSchema])],
  providers: [
    PostgresAbuseCounterStore,
    { provide: ABUSE_COUNTER_STORE, useExisting: PostgresAbuseCounterStore },
    {
      provide: AbuseGuard,
      inject: [ABUSE_COUNTER_STORE, APP_CONFIG, CLOCK],
      useFactory: (store: PostgresAbuseCounterStore, config: AppConfig, clock: Clock) =>
        new AbuseGuard({ store, policies: config.abusePolicies, clock }),
    },
    {
      provide: AbuseCounterSweeper,
      inject: [PostgresAbuseCounterStore, CLOCK],
      useFactory: (purge: PostgresAbuseCounterStore, clock: Clock) =>
        new AbuseCounterSweeper({ purge, clock, logger: new Logger('AbuseCounterSweeper') }),
    },
    { provide: APP_FILTER, useClass: AbuseExceptionFilter },
  ],
  exports: [AbuseGuard, AbuseCounterSweeper],
})
export class AbuseProtectionModule {}
