import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';
import { RateLimitedError } from '../../abuse-protection/domain/rate-limited-error';
import { RateLimitedException } from '../../abuse-protection/http/abuse-exception.filter';
import type { DomainError } from '../../shared-kernel/domain-error';
import type { Result } from '../../shared-kernel/result';

export type RequestSource = { ip?: string; socket: { remoteAddress?: string } };

/** A malformed body carries no app data, so the browser may read the 400 from an active app's origin. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown, message: string, grantCors: () => void): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    grantCors();
    throw new BadRequestException({ error: 'invalid_request', message });
  }
  return parsed.data;
}

/**
 * An IP limit is a 429 with `Retry-After` (the exception filter writes it and grants CORS). Every other
 * use case failure here is the caller's input: a 400 with the stable code and message.
 */
export function unwrap(result: Result<void, DomainError>): void {
  if (!result.ok && result.error instanceof RateLimitedError) throw new RateLimitedException(result.error.retryAfterSeconds);
  if (!result.ok) throw new BadRequestException({ error: result.error.code, message: result.error.message });
}

/**
 * The origin binding passed unless the client was rejected (unknown, inactive or origin not bound to
 * the app). Later failures (invalid email, weak password) depend only on the caller's own input.
 */
export function grantUnlessClientRejected(result: Result<void, DomainError>, grantCors: () => void): void {
  if (result.ok || result.error.code !== 'invalid_client') grantCors();
}
