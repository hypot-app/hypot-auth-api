export interface RefreshTokenProps {
  /** SHA-256 of the token. The token itself is never stored (ADR 13). */
  tokenHash: Buffer;
  sessionId: string;
  createdAt: Date;
  /** Idle expiry, capped at the session expiry. */
  expiresAt: Date;
  /** Set when the token was rotated into its successor. */
  consumedAt: Date | null;
  /** SHA-256 of the successor issued by that rotation (reuse grace window, ADR 35). */
  replacedByHash: Buffer | null;
  /** SHA-256 of the normalized client IP that rotated it. */
  consumedIpHash: Buffer | null;
  /** Set once, when this rotated token has used its grace. */
  graceUsedAt: Date | null;
  /** Set on a successor revoked by a grace reuse. */
  revokedAt: Date | null;
}

/** One issued refresh token of a session. Plain TypeScript: no framework imports. */
export class RefreshToken implements RefreshTokenProps {
  readonly tokenHash: Buffer;
  readonly sessionId: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly replacedByHash: Buffer | null;
  readonly consumedIpHash: Buffer | null;
  readonly graceUsedAt: Date | null;
  readonly revokedAt: Date | null;

  private constructor(props: RefreshTokenProps) {
    this.tokenHash = props.tokenHash;
    this.sessionId = props.sessionId;
    this.createdAt = props.createdAt;
    this.expiresAt = props.expiresAt;
    this.consumedAt = props.consumedAt;
    this.replacedByHash = props.replacedByHash;
    this.consumedIpHash = props.consumedIpHash;
    this.graceUsedAt = props.graceUsedAt;
    this.revokedAt = props.revokedAt;
  }

  /** A new unused token: it expires after the idle TTL, but never after its session (ADR 35). */
  static issue(input: { tokenHash: Buffer; session: { id: string; expiresAt: Date }; now: Date; idleTtlSeconds: number }): RefreshToken {
    const idleEnd = input.now.getTime() + input.idleTtlSeconds * 1000;
    return new RefreshToken({
      tokenHash: input.tokenHash,
      sessionId: input.session.id,
      createdAt: input.now,
      expiresAt: new Date(Math.min(idleEnd, input.session.expiresAt.getTime())),
      consumedAt: null,
      replacedByHash: null,
      consumedIpHash: null,
      graceUsedAt: null,
      revokedAt: null,
    });
  }

  /** Rebuilds a token that was already stored. */
  static restore(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }
}
