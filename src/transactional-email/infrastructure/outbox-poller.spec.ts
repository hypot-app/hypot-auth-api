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
    expect(drain).toHaveBeenCalledWith(BATCH);
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

  it('start() twice does not double the polling', async () => {
    const drain = jest.fn().mockResolvedValue(0);
    const { poller } = setup(drain);
    poller.start();
    poller.start();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(drain).toHaveBeenCalledTimes(2);
    poller.stop();
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
