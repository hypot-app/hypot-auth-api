import { SEND_DEADLINE_MS, type WorkerLogger } from '../application/outbox-worker';

const POLL_INTERVAL_MS = 2_000;
/** Emails handled per tick, so one busy tick cannot starve shutdown. */
const BATCH_SIZE = 20;

/**
 * Runs the outbox worker on a timer. Started explicitly by main.ts (tests and the CLI
 * never start it). Ticks never overlap: a slow drain makes the next ticks skip.
 */
export class OutboxPoller {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly worker: { drain(limit: number, isStopped: () => boolean): Promise<number> },
    private readonly logger: WorkerLogger,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Nest calls this on shutdown, before it closes the database. Stops scheduling, lets
   * the email being sent finish (so its outcome is stored and it is not sent again on
   * restart), and gives up after the send deadline, which bounds any send.
   */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    const inFlight = this.inFlight;
    if (inFlight === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SEND_DEADLINE_MS);
    });
    try {
      await Promise.race([inFlight, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private tick(): Promise<void> {
    // Ticks never overlap: while a drain is in flight, later ticks do nothing.
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.drain().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async drain(): Promise<void> {
    try {
      await this.worker.drain(BATCH_SIZE, () => this.stopped);
    } catch (error) {
      // Message only: a driver error object can carry query parameters.
      this.logger.error(`outbox drain failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}
