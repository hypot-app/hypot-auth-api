import type { Clock } from '../../shared-kernel/clock';
import type { ExpiredCounterPurge } from '../domain/abuse-counter.store';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const BATCH_SIZE = 1_000;

/**
 * Deletes expired counters on a timer (ADR 36). Started explicitly by main.ts, like the outbox
 * poller: tests and the CLI never start it. Sweeps never overlap.
 */
export class AbuseCounterSweeper {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly deps: { purge: ExpiredCounterPurge; clock: Clock; logger: { error(message: string): void } },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Deletes batches until one comes back short, or the sweeper is stopped. Returns the rows deleted. */
  async sweepOnce(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.deps.purge.deleteExpired(this.deps.clock.now(), BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE || this.stopped) return total;
    }
  }

  /** Nest calls this on shutdown, before it closes the database: no new sweep, and the current one finishes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.inFlight;
  }

  private tick(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.sweepOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        // Message only: a driver error object can carry query parameters.
        this.deps.logger.error(`abuse counter sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = run;
    return run;
  }
}
