import type { Clock } from '../../shared-kernel/clock';
import type { RetentionPurge } from './retention-purge';

const SWEEP_INTERVAL_MS = 60 * 60_000;
const BATCH_SIZE = 1_000;
const DAY_MS = 86_400_000;

/** ADR 35 windows. Consumed refresh tokens live as long as their session, so reuse detection outlives rotation. */
const SESSION_RETENTION_MS = DAY_MS;
const ONE_TIME_TOKEN_RETENTION_MS = DAY_MS;
const OUTBOX_RETENTION_MS = 7 * DAY_MS;

export interface SweepResult {
  sessions: number;
  oneTimeTokens: number;
  outbox: number;
}

/**
 * Hourly retention job (ADR 35). Started explicitly by main.ts, like the outbox poller and the counter sweeper:
 * tests and the CLI never start it. Every delete is one self-contained statement on its own pool connection, never
 * inside a unit of work, so a sweep holds at most one connection and never waits for a second. Sweeps never overlap.
 */
export class RetentionSweeper {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly deps: { purge: RetentionPurge; clock: Clock; logger: { error(message: string): void } },
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    // Rows left by a long outage or a restart should not wait a whole interval.
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Runs every category to completion, or until stopped. A failing category is logged and does not starve the rest. */
  async sweepOnce(): Promise<SweepResult> {
    const { purge, clock } = this.deps;
    const now = clock.now().getTime();
    const before = (windowMs: number) => new Date(now - windowMs);
    return {
      sessions: await this.drain('sessions', (limit) => purge.deleteExpiredSessions(before(SESSION_RETENTION_MS), limit)),
      oneTimeTokens: await this.drain('one-time tokens', (limit) =>
        purge.deleteExpiredOneTimeTokens(before(ONE_TIME_TOKEN_RETENTION_MS), limit),
      ),
      outbox: await this.drain('outbox', (limit) => purge.deleteSettledOutbox(before(OUTBOX_RETENTION_MS), limit)),
    };
  }

  /** Nest calls this on shutdown, before it closes the database: no new sweep, and the current one finishes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.inFlight;
  }

  private async drain(label: string, deleteBatch: (limit: number) => Promise<number>): Promise<number> {
    if (this.stopped) return 0;
    let total = 0;
    try {
      for (;;) {
        const deleted = await deleteBatch(BATCH_SIZE);
        total += deleted;
        if (deleted < BATCH_SIZE || this.stopped) return total;
      }
    } catch (error) {
      // Message only: a driver error object can carry query parameters.
      this.deps.logger.error(
        `retention sweep of ${label} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return total;
    }
  }

  private tick(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.sweepOnce()
      .then(() => undefined)
      .finally(() => {
        this.inFlight = undefined;
      });
    this.inFlight = run;
    return run;
  }
}
