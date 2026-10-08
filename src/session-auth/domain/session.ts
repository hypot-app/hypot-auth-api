export const SESSION_REVOKED_REASONS = ['logout', 'reuse_detected', 'password_changed', 'password_reset', 'ops_revoke_all'] as const;
export type SessionRevokedReason = (typeof SESSION_REVOKED_REASONS)[number];

export interface SessionProps {
  id: string;
  appId: string;
  userId: string;
  createdAt: Date;
  lastUsedAt: Date;
  /** Absolute end of the session. Rotating a refresh token never moves it (ADR 35). */
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
}

/** A refresh-token family, bound to one app and one account. Plain TypeScript: no framework imports. */
export class Session implements SessionProps {
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: SessionRevokedReason | null;

  private constructor(props: SessionProps) {
    this.id = props.id;
    this.appId = props.appId;
    this.userId = props.userId;
    this.createdAt = props.createdAt;
    this.lastUsedAt = props.lastUsedAt;
    this.expiresAt = props.expiresAt;
    this.revokedAt = props.revokedAt;
    this.revokedReason = props.revokedReason;
  }

  /** A new active session that ends `absoluteTtlSeconds` after `now`. */
  static open(input: { id: string; appId: string; userId: string; now: Date; absoluteTtlSeconds: number }): Session {
    return new Session({
      id: input.id,
      appId: input.appId,
      userId: input.userId,
      createdAt: input.now,
      lastUsedAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.absoluteTtlSeconds * 1000),
      revokedAt: null,
      revokedReason: null,
    });
  }

  /** Rebuilds a session that was already stored. */
  static restore(props: SessionProps): Session {
    return new Session(props);
  }
}
