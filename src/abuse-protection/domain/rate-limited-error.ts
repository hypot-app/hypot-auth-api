import { DomainError } from '../../shared-kernel/domain-error';

/**
 * An IP-keyed limit was hit. Use cases return it as their error so the HTTP layer can answer `429`
 * with an integer `Retry-After`. It depends on the caller's IP and the endpoint only, never on account state.
 */
export class RateLimitedError extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super('rate_limited', 'Too many requests. Try again later.');
    this.name = 'RateLimitedError';
  }
}
