import { Logger, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '../../shared-kernel/clock';
import { PostgresRetentionPurge } from './postgres-retention-purge';
import { RETENTION_PURGE, type RetentionPurge } from './retention-purge';
import { RetentionSweeper } from './retention-sweeper';

/** The hourly retention job (ADR 35). It only runs when main.ts starts it; the CLI does not import this module. */
@Module({
  providers: [
    PostgresRetentionPurge,
    { provide: RETENTION_PURGE, useExisting: PostgresRetentionPurge },
    {
      provide: RetentionSweeper,
      inject: [RETENTION_PURGE, CLOCK],
      useFactory: (purge: RetentionPurge, clock: Clock) =>
        new RetentionSweeper({ purge, clock, logger: new Logger('RetentionSweeper') }),
    },
  ],
  exports: [RetentionSweeper],
})
export class RetentionModule {}
