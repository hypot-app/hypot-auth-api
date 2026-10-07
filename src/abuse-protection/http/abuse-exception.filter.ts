import { Catch, HttpException, HttpStatus, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { TemporarilyUnavailable } from '../domain/temporarily-unavailable';

/**
 * An IP-keyed limit was hit (`429`). The decision depends on the caller's IP and the endpoint only,
 * never on account state. Controllers call their `@CorsGrant()` function before throwing it, so a
 * browser on an active app's origin can read the answer (the body carries no app data).
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

/** Writes `429` with an integer `Retry-After`, and `503` when the limiter store fails (ADR 36). */
@Catch(RateLimitedException, TemporarilyUnavailable)
export class AbuseExceptionFilter implements ExceptionFilter {
  catch(exception: RateLimitedException | TemporarilyUnavailable, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<ServerResponse>();
    const limited = exception instanceof RateLimitedException;
    res.statusCode = limited ? HttpStatus.TOO_MANY_REQUESTS : HttpStatus.SERVICE_UNAVAILABLE;
    if (limited) res.setHeader('Retry-After', String(exception.retryAfterSeconds));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(limited ? exception.getResponse() : UNAVAILABLE_BODY));
  }
}
