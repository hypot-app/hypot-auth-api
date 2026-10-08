import type { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import type { Session, SessionRevokedReason } from '../../src/session-auth/domain/session';
import type { ConsumedToken, SessionRepository, TokenState } from '../../src/session-auth/domain/session.repository';

interface StoredSession {
  id: string;
  appId: string;
  userId: string;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
}

interface StoredToken {
  hash: Buffer;
  sessionId: string;
  expiresAt: Date;
  consumedAt: Date | null;
  replacedByHash: Buffer | null;
  consumedIpHash: Buffer | null;
  graceUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Unit-test double that follows the conditional statements of `TypeOrmSessionRepository` one for
 * one (the int-spec pins the SQL). It has no transaction: a rollback is the unit of work fake's job.
 */
export class InMemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, StoredSession>();
  private readonly tokens = new Map<string, StoredToken>();
  /** Names of the repository methods called, in order, for ordering assertions. */
  readonly calls: string[] = [];

  async open(session: Session, firstToken: RefreshToken): Promise<void> {
    this.calls.push('open');
    this.sessions.set(session.id, {
      id: session.id,
      appId: session.appId,
      userId: session.userId,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      revokedReason: session.revokedReason,
    });
    await this.addToken(firstToken);
  }

  async addToken(token: RefreshToken): Promise<void> {
    this.calls.push('addToken');
    this.tokens.set(token.tokenHash.toString('hex'), {
      hash: token.tokenHash,
      sessionId: token.sessionId,
      expiresAt: token.expiresAt,
      consumedAt: token.consumedAt,
      replacedByHash: token.replacedByHash,
      consumedIpHash: token.consumedIpHash,
      graceUsedAt: token.graceUsedAt,
      revokedAt: token.revokedAt,
    });
  }

  async consume(hash: Buffer, appId: string, now: Date, successorHash: Buffer, ipHash: Buffer): Promise<ConsumedToken | null> {
    this.calls.push('consume');
    const token = this.tokens.get(hash.toString('hex'));
    const session = token && this.sessions.get(token.sessionId);
    if (!token || !session) return null;
    const usable =
      token.consumedAt === null &&
      token.revokedAt === null &&
      token.expiresAt > now &&
      session.appId === appId &&
      session.revokedAt === null &&
      session.expiresAt > now;
    if (!usable) return null;
    token.consumedAt = now;
    token.replacedByHash = successorHash;
    token.consumedIpHash = ipHash;
    return { sessionId: session.id, userId: session.userId, sessionExpiresAt: session.expiresAt };
  }

  async findTokenState(hash: Buffer): Promise<TokenState | null> {
    this.calls.push('findTokenState');
    const token = this.tokens.get(hash.toString('hex'));
    const session = token && this.sessions.get(token.sessionId);
    if (!token || !session) return null;
    return {
      sessionId: session.id,
      appId: session.appId,
      userId: session.userId,
      tokenExpiresAt: token.expiresAt,
      consumedAt: token.consumedAt,
      consumedIpHash: token.consumedIpHash,
      replacedByHash: token.replacedByHash,
      graceUsedAt: token.graceUsedAt,
      tokenRevokedAt: token.revokedAt,
      sessionExpiresAt: session.expiresAt,
      sessionRevokedAt: session.revokedAt,
    };
  }

  async touch(sessionId: string, now: Date): Promise<void> {
    this.calls.push('touch');
    const session = this.sessions.get(sessionId);
    if (session) session.lastUsedAt = now;
  }

  async revoke(sessionId: string, reason: SessionRevokedReason, now: Date): Promise<void> {
    this.calls.push('revoke');
    const session = this.sessions.get(sessionId);
    if (session && session.revokedAt === null) {
      session.revokedAt = now;
      session.revokedReason = reason;
    }
  }

  async revokeAllForUser(userId: string, reason: SessionRevokedReason, now: Date): Promise<number> {
    this.calls.push('revokeAllForUser');
    let revoked = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = now;
        session.revokedReason = reason;
        revoked += 1;
      }
    }
    return revoked;
  }

  async claimGrace(hash: Buffer, now: Date): Promise<Buffer | null> {
    this.calls.push('claimGrace');
    const token = this.tokens.get(hash.toString('hex'));
    if (!token || token.graceUsedAt !== null || token.consumedAt === null || token.revokedAt !== null) return null;
    token.graceUsedAt = now;
    return token.replacedByHash;
  }

  async revokeToken(hash: Buffer, now: Date): Promise<boolean> {
    this.calls.push('revokeToken');
    const token = this.tokens.get(hash.toString('hex'));
    if (!token || token.consumedAt !== null || token.revokedAt !== null) return false;
    token.revokedAt = now;
    return true;
  }

  /** Test helper: the stored token, to assert on its state. */
  token(hash: Buffer): StoredToken | undefined {
    return this.tokens.get(hash.toString('hex'));
  }

  /** Snapshot and restore, so a fake unit of work can roll back a failed run. */
  snapshot(): () => void {
    const sessions = new Map([...this.sessions].map(([key, value]) => [key, { ...value }]));
    const tokens = new Map([...this.tokens].map(([key, value]) => [key, { ...value }]));
    return () => {
      this.sessions.clear();
      for (const [key, value] of sessions) this.sessions.set(key, value);
      this.tokens.clear();
      for (const [key, value] of tokens) this.tokens.set(key, value);
    };
  }
}
