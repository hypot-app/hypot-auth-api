import type { OneTimeToken, OneTimeTokenPurpose } from './one-time-token';

/** Port: storage of single-use link tokens. Implementations join the current unit of work. */
export interface OneTimeTokenRepository {
  save(token: OneTimeToken): Promise<void>;
  /**
   * Marks the token with this hash as consumed and returns it, but only when it has the
   * given purpose, is unconsumed and unexpired at `now`. Returns null otherwise, changing
   * nothing. Atomic: of two concurrent calls with the same hash, at most one gets the token.
   */
  consumeByHash(hash: Buffer, purpose: OneTimeTokenPurpose, now: Date): Promise<OneTimeToken | null>;
  /** Marks every unconsumed token of the user with this purpose as consumed (superseded). */
  invalidateOutstanding(userId: string, purpose: OneTimeTokenPurpose, now: Date): Promise<void>;
}

export const ONE_TIME_TOKEN_REPOSITORY = Symbol('OneTimeTokenRepository');
