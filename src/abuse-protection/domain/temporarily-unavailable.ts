import type { Scope } from './scope';

/**
 * The limiter store failed. Credential endpoints fail closed with a 503 instead of
 * running without limits (ADR 36). Raised before any account lookup, so it reveals nothing.
 * `scope` names the counter family for the operator log; it never carries keys or IPs.
 */
export class TemporarilyUnavailable extends Error {
  readonly scope: Scope;

  constructor(options: { cause: unknown; scope: Scope }) {
    super('The abuse-protection store is unavailable', { cause: options.cause });
    this.name = 'TemporarilyUnavailable';
    this.scope = options.scope;
  }
}
