import type { WorkerLogger } from '../application/outbox-worker';

const POLL_INTERVAL_MS = 2_000;
/** Emails handled per tick, so one busy tick cannot starve shutdown. */
const BATCH_SIZE = 20;

/**
 * Runs the outbox worker on a timer. Started explicitly by main.ts (tests and the CLI
 * never start it). Ticks never overlap: a slow drain makes the next ticks skip.
 */
export class OutboxPoller {
  private timer: NodeJS.Timeout | undefined;
  private draining = false;

  constructor(
    private readonly worker: { drain(limit: number): Promise<number> },
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Nest calls this on shutdown. */
  onModuleDestroy(): void {
    this.stop();
  }

  private async tick(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.worker.drain(BATCH_SIZE);
    } catch (error) {
      // Message only: a driver error object can carry query parameters.
      this.logger.error(`outbox drain failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      this.draining = false;
    }
  }
}
