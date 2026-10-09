import { FixedClock } from '../../shared-kernel/clock';
import type { RetentionPurge } from './retention-purge';
import { RetentionSweeper } from './retention-sweeper';

const T0 = new Date('2026-03-10T12:00:00.000Z');
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const before = (ms: number) => new Date(T0.getTime() - ms);

type Deleter = jest.Mock<Promise<number>, [Date, number]>;

function fakePurge(overrides: Partial<Record<keyof RetentionPurge, Deleter>> = {}) {
  return {
    deleteExpiredSessions: jest.fn().mockResolvedValue(0) as Deleter,
    deleteExpiredOneTimeTokens: jest.fn().mockResolvedValue(0) as Deleter,
    deleteSettledOutbox: jest.fn().mockResolvedValue(0) as Deleter,
    ...overrides,
  };
}

function setup(purge: ReturnType<typeof fakePurge>) {
  const errors: string[] = [];
  const sweeper = new RetentionSweeper({
    purge,
    clock: new FixedClock(T0),
    logger: { error: (message) => errors.push(message) },
  });
  return { sweeper, errors };
}

describe('RetentionSweeper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('uses the ADR 35 windows: one day for sessions and one-time tokens, seven days for the outbox', async () => {
    const purge = fakePurge();
    const { sweeper } = setup(purge);

    await sweeper.sweepOnce();

    expect(purge.deleteExpiredSessions).toHaveBeenCalledWith(before(DAY_MS), 1000);
    expect(purge.deleteExpiredOneTimeTokens).toHaveBeenCalledWith(before(DAY_MS), 1000);
    expect(purge.deleteSettledOutbox).toHaveBeenCalledWith(before(7 * DAY_MS), 1000);
  });

  it('does nothing until started, then sweeps at once and every hour, and stops when stopped', async () => {
    const purge = fakePurge();
    const { sweeper } = setup(purge);

    await jest.advanceTimersByTimeAsync(HOUR_MS * 3);
    expect(purge.deleteExpiredSessions).not.toHaveBeenCalled();

    sweeper.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(HOUR_MS * 2);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(3);
    expect(purge.deleteSettledOutbox).toHaveBeenCalledTimes(3);

    sweeper.stop();
    await jest.advanceTimersByTimeAsync(HOUR_MS * 2);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(3);
  });

  it('keeps deleting batches of 1,000 until one comes back short, per category', async () => {
    const purge = fakePurge({
      deleteExpiredSessions: jest.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValue(37),
      deleteSettledOutbox: jest.fn().mockResolvedValueOnce(1000).mockResolvedValue(0),
    });
    const { sweeper } = setup(purge);

    expect(await sweeper.sweepOnce()).toEqual({ sessions: 2037, oneTimeTokens: 0, outbox: 1000 });
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(3);
    expect(purge.deleteExpiredOneTimeTokens).toHaveBeenCalledTimes(1);
    expect(purge.deleteSettledOutbox).toHaveBeenCalledTimes(2);
  });

  it('logs a failed category by message and still sweeps the others', async () => {
    const purge = fakePurge({ deleteExpiredSessions: jest.fn().mockRejectedValue(new Error('db down')) });
    const { sweeper, errors } = setup(purge);

    const result = await sweeper.sweepOnce();

    expect(errors).toEqual(['retention sweep of sessions failed: db down']);
    expect(result).toEqual({ sessions: 0, oneTimeTokens: 0, outbox: 0 });
    expect(purge.deleteExpiredOneTimeTokens).toHaveBeenCalledTimes(1);
    expect(purge.deleteSettledOutbox).toHaveBeenCalledTimes(1);
  });

  it('never overlaps two sweeps', async () => {
    let release!: () => void;
    const purge = fakePurge({
      deleteExpiredSessions: jest
        .fn()
        .mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(0))))
        .mockResolvedValue(0),
    });
    const { sweeper } = setup(purge);
    sweeper.start();
    await jest.advanceTimersByTimeAsync(HOUR_MS * 2);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(1);

    release();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });

  it('waits for the sweep in flight when the app shuts down, and starts no new one', async () => {
    let release!: () => void;
    const purge = fakePurge({
      deleteExpiredSessions: jest
        .fn()
        .mockImplementation(() => new Promise<number>((resolve) => (release = () => resolve(0)))),
    });
    const { sweeper } = setup(purge);
    sweeper.start();
    await jest.advanceTimersByTimeAsync(0);

    let drained = false;
    const shutdown = sweeper.onModuleDestroy().then(() => (drained = true));
    await jest.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);

    release();
    await shutdown;
    expect(drained).toBe(true);
    // The in-flight sweep stops after its current category instead of working through the rest.
    expect(purge.deleteExpiredOneTimeTokens).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(HOUR_MS * 2);
    expect(purge.deleteExpiredSessions).toHaveBeenCalledTimes(1);
  });
});
