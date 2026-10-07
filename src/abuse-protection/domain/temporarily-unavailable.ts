/**
 * The limiter store failed. Credential endpoints fail closed with a 503 instead of
 * running without limits (ADR 36). Raised before any account lookup, so it reveals nothing.
 */
export class TemporarilyUnavailable extends Error {
  constructor(options?: { cause: unknown }) {
    super('The abuse-protection store is unavailable', options);
    this.name = 'TemporarilyUnavailable';
  }
}
