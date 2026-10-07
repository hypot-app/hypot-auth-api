import type { ArgumentsHost } from '@nestjs/common';
import { FixedClock } from '../../shared-kernel/clock';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';
import { AbuseExceptionFilter, RateLimitedException } from './abuse-exception.filter';

const T0 = new Date('2026-03-01T12:00:00.000Z');

function setup(origin: string | null = 'https://a.example') {
  const headers = new Map<string, string>();
  const res = { statusCode: 0, setHeader: (k: string, v: string) => void headers.set(k, v), end: jest.fn() };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ corsCandidateOrigin: origin ?? undefined }) }),
  } as unknown as ArgumentsHost;
  const logger = { error: jest.fn() };
  const clock = new FixedClock(T0);
  const filter = new AbuseExceptionFilter(clock, logger);
  return { filter, host, res, headers, logger, clock };
}

const down = (scope: 'login_ip' | 'email_account' = 'login_ip', message = 'connection refused') =>
  new TemporarilyUnavailable({ cause: new Error(message), scope });

describe('AbuseExceptionFilter: logging a limiter outage (W2)', () => {
  it('logs the scope and the driver message, and nothing else', () => {
    const { filter, host, logger } = setup();

    filter.catch(down('email_account', 'connection refused'), host);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('abuse limiter store unavailable (email_account): connection refused');
  });

  it('logs a non-Error cause without printing it', () => {
    const { filter, host, logger } = setup();

    filter.catch(new TemporarilyUnavailable({ cause: { password: 'hunter2' }, scope: 'login_ip' }), host);

    expect(logger.error).toHaveBeenCalledWith('abuse limiter store unavailable (login_ip): unknown error');
  });

  it('logs at most once per 60 seconds, so an outage cannot flood the log', () => {
    const { filter, host, logger, clock } = setup();
    filter.catch(down(), host);

    clock.advanceMs(59_999);
    filter.catch(down(), host);
    expect(logger.error).toHaveBeenCalledTimes(1);

    clock.advanceMs(1);
    filter.catch(down(), host);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('does not log a 429, which is normal traffic', () => {
    const { filter, host, logger } = setup();
    filter.catch(new RateLimitedException(30), host);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('AbuseExceptionFilter: answers', () => {
  it('writes 503 without Retry-After', () => {
    const { filter, host, res, headers } = setup();
    filter.catch(down(), host);

    expect(res.statusCode).toBe(503);
    expect(headers.has('Retry-After')).toBe(false);
  });

  it('writes 429 with an integer Retry-After', () => {
    const { filter, host, res, headers } = setup();
    filter.catch(new RateLimitedException(30), host);

    expect(res.statusCode).toBe(429);
    expect(headers.get('Retry-After')).toBe('30');
  });

  it.each([
    ['429', () => new RateLimitedException(30)],
    ['503', () => down()],
  ])('lets a browser on the candidate origin read the %s', (_status, make) => {
    const { filter, host, headers } = setup('https://a.example');
    filter.catch(make(), host);
    expect(headers.get('Access-Control-Allow-Origin')).toBe('https://a.example');
  });

  it.each([
    ['429', () => new RateLimitedException(30)],
    ['503', () => down()],
  ])('adds no allow header to a %s when the request has no candidate origin', (_status, make) => {
    const { filter, host, headers } = setup(null);
    filter.catch(make(), host);
    expect(headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});
