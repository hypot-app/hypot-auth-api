import type { Type } from '@nestjs/common';
import { AbuseCounterSweeper } from './abuse-protection/application/abuse-counter-sweeper';
import { RetentionSweeper } from './platform/retention/retention-sweeper';
import { OutboxPoller } from './transactional-email/infrastructure/outbox-poller';

/** The slice of the Nest application this needs, so a test can pass a fake. */
export interface JobHost {
  get<T>(token: Type<T>): T;
}

/**
 * Starts every timer-driven job: the outbox poller, the abuse counter sweeper and the retention sweeper. Called by
 * main.ts only. The operator CLI and the test factories never call it, so nothing in them runs on a timer. Each job
 * stops itself in `onModuleDestroy` and awaits its work in flight, before Nest closes the database.
 */
export function startBackgroundJobs(app: JobHost): void {
  app.get(OutboxPoller).start();
  app.get(AbuseCounterSweeper).start();
  app.get(RetentionSweeper).start();
}
