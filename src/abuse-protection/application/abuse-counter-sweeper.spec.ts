import { FixedClock } from '../../shared-kernel/clock';
import { AbuseCounterSweeper } from './abuse-counter-sweeper';

const T0 = new Date('2026-03-01T12:00:00.000Z');
const INTERVAL_MS = 5 * 60_000;

describe('AbuseCounterSweeper', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const setup = (deleteExpired: jest.Mock<Promise<number>, [Date, number]>) => {
    const errors: string[] = [];
    const sweeper = new AbuseCounterSweeper({
      purge: { deleteExpired },
      clock: new FixedClock(T0),
      logger: { error: (message) => errors.push(message) },
    });
    return { sweeper, errors };
  };

  it('does nothing until started, then sweeps every 5 minutes', async () => {
    const deleteExpired = jest.fn().mockResolvedValue(0);
    const { sweeper } = setup(deleteExpired);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(deleteExpired).not.toHaveBeenCalled();

    sweeper.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
    expect(deleteExpired).toHaveBeenCalledWith(T0, 1000);

    sweeper.stop();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
  });

  it('keeps deleting batches of 1,000 until one comes back short', async () => {
    const deleteExpired = jest.fn().mockResolvedValueOnce(1000).mockResolvedValueOnce(1000).mockResolvedValue(37);
    const { sweeper } = setup(deleteExpired);

    expect(await sweeper.sweepOnce()).toBe(2037);
    expect(deleteExpired).toHaveBeenCalledTimes(3);
  });

  it('logs the message of a failed sweep and tries again on the next tick', async () => {
    const deleteExpired = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(0);
    const { sweeper, errors } = setup(deleteExpired);
    sweeper.start();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(errors).toEqual(['abuse counter sweep failed: db down']);
    expect(deleteExpired).toHaveBeenCalledTimes(2);
    sweeper.stop();
  });

  it('waits for the sweep in flight when the app shuts down', async () => {
    let release!: () => void;
    const deleteExpired = jest.fn().mockImplementation(() => new Promise<number>((resolve) => (release = () => resolve(0))));
    const { sweeper } = setup(deleteExpired);
    sweeper.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);

    let drained = false;
    const shutdown = sweeper.onModuleDestroy().then(() => (drained = true));
    await jest.advanceTimersByTimeAsync(1);
    expect(drained).toBe(false);

    release();
    await shutdown;
    expect(drained).toBe(true);
  });
});
