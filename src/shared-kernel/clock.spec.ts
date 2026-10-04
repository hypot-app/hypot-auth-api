import { FixedClock, SystemClock } from './clock';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('returns a new Date on every call', () => {
    const clock = new SystemClock();
    expect(clock.now()).not.toBe(clock.now());
  });
});

describe('FixedClock', () => {
  it('returns the configured instant and can be advanced', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');

    clock.advanceMs(60_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('does not let callers mutate its internal state', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.now().setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
