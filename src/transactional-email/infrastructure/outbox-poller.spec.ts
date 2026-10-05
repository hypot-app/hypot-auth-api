import { SEND_DEADLINE_MS } from '../application/outbox-worker';
import { OutboxPoller } from './outbox-poller';

const INTERVAL_MS = 2_000;
const BATCH = 20;

describe('OutboxPoller', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const setup = (drain: jest.Mock<Promise<number>, [number]>) => {
    const errors: string[] = [];
    const poller = new OutboxPoller({ drain }, { warn: () => undefined, error: (m) => errors.push(m) });
    return { poller, errors };
  };

  it('does nothing until started, then drains a batch on every interval', async () => {
    const drain = jest.fn().mockResolvedValue(0);
    const { poller } = setup(drain);

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(drain).not.toHaveBeenCalled();

    poller.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);

    expect(drain).toHaveBeenCalledTimes(3);
    expect(drain).toHaveBeenCalledWith(BATCH, expect.any(Function));
    poller.stop();
  });

  it('stops draining after stop()', async () => {
    const drain = jest.fn().mockResolvedValue(0);
    const { poller } = setup(drain);
    poller.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    poller.stop();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 5);

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('never runs two drains at once: a slow drain makes later ticks skip', async () => {
    let release!: () => void;
    const drain = jest.fn().mockImplementationOnce(() => new Promise<number>((resolve) => (release = () => resolve(1))));
    drain.mockResolvedValue(0);
    const { poller } = setup(drain);
    poller.start();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 4); // first drain still pending
    expect(drain).toHaveBeenCalledTimes(1);

    release();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(drain).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  describe('shutdown', () => {
    const pendingDrain = () => {
      let release!: () => void;
      const drain = jest.fn().mockImplementation(() => new Promise<number>((resolve) => (release = () => resolve(1))));
      return { drain, release: () => release() };
    };

    it('waits for the in-flight drain before onModuleDestroy resolves, and schedules nothing more', async () => {
      const { drain, release } = pendingDrain();
      const { poller } = setup(drain);
      poller.start();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS); // a send is now in flight

      let destroyed = false;
      const destroying = poller.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(INTERVAL_MS * 5);
      expect(destroyed).toBe(false);
      expect(drain).toHaveBeenCalledTimes(1);

      release();
      await destroying;
      expect(destroyed).toBe(true);
      await jest.advanceTimersByTimeAsync(INTERVAL_MS * 5);
      expect(drain).toHaveBeenCalledTimes(1);
    });

    it('resolves at once when nothing is in flight', async () => {
      const { poller } = setup(jest.fn().mockResolvedValue(0));
      poller.start();
      await expect(poller.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('gives up waiting after the send deadline', async () => {
      const { drain } = pendingDrain();
      const { poller } = setup(drain);
      poller.start();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);

      let destroyed = false;
      const destroying = poller.onModuleDestroy().then(() => (destroyed = true));
      await jest.advanceTimersByTimeAsync(SEND_DEADLINE_MS - 1);
      expect(destroyed).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await destroying;
      expect(destroyed).toBe(true);
    });

    it('tells the worker to stop after the current email once shutdown began', async () => {
      const { drain } = pendingDrain();
      const { poller } = setup(drain);
      poller.start();
      await jest.advanceTimersByTimeAsync(INTERVAL_MS);
      const isStopped = drain.mock.calls[0][1] as () => boolean;

      expect(isStopped()).toBe(false);
      void poller.onModuleDestroy();
      expect(isStopped()).toBe(true);
    });
  });

  it('logs a drain failure with its message only and keeps polling', async () => {
    const drain = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('connection terminated'), { parameters: ['secret-token'] }))
      .mockResolvedValue(0);
    const { poller, errors } = setup(drain);
    poller.start();

    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(errors).toEqual(['outbox drain failed: connection terminated']);
    expect(drain).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});
