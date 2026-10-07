import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { grantCorsAllow, type CorsRequest } from '../../app-registry/http/cors-grant';
import type { Clock } from '../../shared-kernel/clock';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';

/**
 * An IP-keyed limit was hit (`429`). The decision depends on the caller's IP and the endpoint only,
 * never on account state.
 */
export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super({ error: 'rate_limited', message: 'Too many requests. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

const UNAVAILABLE_BODY = {
  error: 'temporarily_unavailable',
  message: 'The service is temporarily unavailable. Try again later.',
};

const OUTAGE_LOG_INTERVAL_MS = 60_000;

/**
 * Writes `429` with an integer `Retry-After`, and `503` when the limiter store fails (ADR 36).
 * Both carry static bodies with no app or account data, so the filter always lets a browser on an
 * active app's origin read them (a no-op without a candidate origin): no controller has to remember.
 */
@Catch(RateLimitedException, TemporarilyUnavailable)
export class AbuseExceptionFilter implements ExceptionFilter {
  private lastOutageLogAt: number | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly logger: { error(message: string): void },
  ) {}

  catch(exception: RateLimitedException | TemporarilyUnavailable, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<ServerResponse>();
    grantCorsAllow(http.getRequest<CorsRequest>(), res);
    const limited = exception instanceof RateLimitedException;
    if (!limited) this.logOutage(exception);
    res.statusCode = limited ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE;
    if (limited) res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(limited ? exception.getResponse() : UNAVAILABLE_BODY));
  }

  /** Scope and driver message only (never keys, IPs or parameters), at most once a minute per process. */
  private logOutage(exception: TemporarilyUnavailable): void {
    const now = this.clock.now().getTime();
    if (this.lastOutageLogAt !== undefined && now - this.lastOutageLogAt < OUTAGE_LOG_INTERVAL_MS) return;
    this.lastOutageLogAt = now;
    const { cause } = exception;
    this.logger.error(
      `abuse limiter store unavailable (${exception.scope}): ${cause instanceof Error ? cause.message : 'unknown error'}`,
    );
  }
}
