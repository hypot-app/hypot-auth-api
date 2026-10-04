/** Port: the only way domain and application code read the current time. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('Clock');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Test double with a controllable instant. */
export class FixedClock implements Clock {
  private current: number;

  constructor(start: Date) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceMs(ms: number): void {
    this.current += ms;
  }
}
