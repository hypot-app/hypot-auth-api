export type OneTimeTokenPurpose = 'email_verification' | 'password_reset';

const HOUR_MS = 3_600_000;

/**
 * How many hours a token works (spec: confirmation 24 h; reset 1 h). The default email templates say the same
 * numbers in words; a test pins them to this table, so changing a TTL fails until the wording is updated.
 */
export const TOKEN_TTL_HOURS: Record<OneTimeTokenPurpose, number> = {
  email_verification: 24,
  password_reset: 1,
};

export interface OneTimeTokenProps {
  id: string;
  userId: string;
  purpose: OneTimeTokenPurpose;
  /** SHA-256 of the token. The token itself is never stored. */
  tokenHash: Buffer;
  expiresAt: Date;
  /** Set when the token is used or superseded by a newer one. */
  consumedAt: Date | null;
}

/** A single-use link token. Plain TypeScript: no framework or persistence imports. */
export class OneTimeToken implements OneTimeTokenProps {
  readonly id: string;
  readonly userId: string;
  readonly purpose: OneTimeTokenPurpose;
  readonly tokenHash: Buffer;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;

  private constructor(props: OneTimeTokenProps) {
    this.id = props.id;
    this.userId = props.userId;
    this.purpose = props.purpose;
    this.tokenHash = props.tokenHash;
    this.expiresAt = props.expiresAt;
    this.consumedAt = props.consumedAt;
  }

  static issue(input: { id: string; userId: string; purpose: OneTimeTokenPurpose; tokenHash: Buffer; now: Date }): OneTimeToken {
    return new OneTimeToken({
      id: input.id,
      userId: input.userId,
      purpose: input.purpose,
      tokenHash: input.tokenHash,
      expiresAt: new Date(input.now.getTime() + TOKEN_TTL_HOURS[input.purpose] * HOUR_MS),
      consumedAt: null,
    });
  }

  /** Rebuilds a token that was already stored. */
  static restore(props: OneTimeTokenProps): OneTimeToken {
    return new OneTimeToken(props);
  }
}
