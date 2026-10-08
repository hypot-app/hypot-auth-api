import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import { ClientRef } from '../../abuse-protection/domain/client-ref';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import { err, ok, type Result } from '../../shared-kernel/result';
import { hashToken, isWellFormedToken, type GeneratedToken, type TokenGenerator } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from '../../token-lifecycle/domain/access-token';
import { hashClientIp } from '../domain/ip-hash';
import { RefreshToken } from '../domain/refresh-token';
import { isGraceEligible } from '../domain/reuse-grace';
import type { SessionRepository, TokenState } from '../domain/session.repository';
import type { LoginTokens } from './login.use-case';

export interface RefreshSessionInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin: string | undefined;
  refreshToken: string;
  ip: ClientIp;
}

/**
 * Why a refresh failed. `invalid_grant` is the one answer for every token problem; `clientBound` says
 * whether the client resolved and its origin was bound to it, which is the only fact the HTTP layer
 * may use (to decide the CORS grant, ADR 38). The cause of the failure is never exposed.
 */
export type RefreshFailure =
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid_client' }
  | { kind: 'invalid_grant'; clientBound: boolean };

export interface RefreshSessionDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  sessions: Pick<SessionRepository, 'consume' | 'findTokenState' | 'addToken' | 'touch' | 'revoke' | 'claimGrace' | 'revokeToken'>;
  tokens: TokenGenerator;
  accessTokens: AccessTokenIssuer;
  clock: Clock;
  uow: UnitOfWork;
  ttls: { idleSeconds: number; absoluteSeconds: number; reuseGraceSeconds: number };
}

/**
 * Rotates a refresh token (ADR 35). The IP limit comes first, before any token lookup, and the
 * origin is bound to the app before a token is consumed, so neither a flood nor a foreign page can
 * burn a valid token. Presenting a token that was already used or revoked revokes its session.
 */
export class RefreshSessionUseCase {
  constructor(private readonly deps: RefreshSessionDeps) {}

  async execute(input: RefreshSessionInput): Promise<Result<LoginTokens, RefreshFailure>> {
    const { abuse, sessions, clock } = this.deps;
    // The origin is bound below, apart from the lookup: an unbound origin must answer like a bad token.
    const resolved = await this.deps.resolveClient.execute({ clientId: input.clientId });
    const client = resolved.ok ? ClientRef.resolved(resolved.value) : ClientRef.unknown();

    const decision = await abuse.checkClientIp('refresh_ip', client, input.ip);
    if (decision.kind === 'ip_limited') return err({ kind: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds });
    if (!resolved.ok) return err({ kind: 'invalid_client' });
    const app = resolved.value;
    if (input.origin !== undefined && !app.allowedOrigins.includes(input.origin)) {
      return err({ kind: 'invalid_grant', clientBound: false });
    }

    const invalid = err<RefreshFailure>({ kind: 'invalid_grant', clientBound: true });
    if (!isWellFormedToken(input.refreshToken)) return invalid;
    const hash = hashToken(input.refreshToken);
    const now = clock.now();

    const successor = this.deps.tokens.generate();
    try {
      const rotated = await this.deps.uow.run(async () => {
        const consumed = await sessions.consume(hash, app.id, now, successor.hash, hashClientIp(input.ip));
        if (consumed === null) return null;
        return this.issuePair(app.clientId, consumed.userId, consumed.sessionId, consumed.sessionExpiresAt, successor, now);
      });
      if (rotated !== null) return ok(rotated);
    } catch (error) {
      // The session closed mid-request: rolled back, nothing to revoke or forgive.
      if (error instanceof SessionClosed) return invalid;
      throw error;
    }

    const reused = await this.handleReuse(hash, app.id, app.clientId, input.ip, now);
    return reused === null ? invalid : ok(reused);
  }

  /** The successor token, the touched session and the access token: shared by rotation and the grace path. */
  private async issuePair(
    clientId: string,
    userId: string,
    sessionId: string,
    sessionExpiresAt: Date,
    successor: GeneratedToken,
    now: Date,
  ): Promise<LoginTokens> {
    const { sessions } = this.deps;
    await sessions.addToken(
      RefreshToken.issue({
        tokenHash: successor.hash,
        session: { id: sessionId, expiresAt: sessionExpiresAt },
        now,
        idleTtlSeconds: this.deps.ttls.idleSeconds,
      }),
    );
    // The session may have closed since it was read; the zero-row touch aborts and rolls the whole unit back.
    if (!(await sessions.touch(sessionId, now))) throw new SessionClosed();
    const access = await this.deps.accessTokens.issue({ accountId: userId, clientId });
    return { accessToken: access.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken: successor.token };
  }

  /**
   * Nothing was consumed. A token that was used or revoked, of THIS app, is a reuse: inside the grace
   * window it may be forgiven once, otherwise its session ends. Anything else (unknown, another app,
   * expired, session already over) changes nothing. Returns the fresh pair, or null for `invalid_grant`.
   */
  private async handleReuse(hash: Buffer, appId: string, clientId: string, ip: ClientIp, now: Date): Promise<LoginTokens | null> {
    const { sessions } = this.deps;
    const state = await sessions.findTokenState(hash);
    if (state === null || state.appId !== appId) return null;
    if (state.consumedAt === null && state.tokenRevokedAt === null) return null;

    const eligible = isGraceEligible(state, { now, ipHash: hashClientIp(ip), graceSeconds: this.deps.ttls.reuseGraceSeconds });
    if (eligible) {
      try {
        return await this.deps.uow.run(() => this.forgive(hash, clientId, state, now));
      } catch (error) {
        if (error instanceof SessionClosed) return null;
        if (!(error instanceof GraceRefused)) throw error;
      }
    }
    await sessions.revoke(state.sessionId, 'reuse_detected', now);
    return null;
  }

  /**
   * ADR 35 steps 2 to 4, in the caller's unit of work: claim the grace, revoke the unused successor, mint
   * a fresh pair. Any zero-row step throws, which rolls the whole unit back.
   */
  private async forgive(hash: Buffer, clientId: string, state: TokenState, now: Date): Promise<LoginTokens> {
    const { sessions } = this.deps;
    const successorHash = await sessions.claimGrace(hash, now);
    if (successorHash === null) throw new GraceRefused();
    if (!(await sessions.revokeToken(successorHash, now))) throw new GraceRefused();
    return this.issuePair(clientId, state.userId, state.sessionId, state.sessionExpiresAt, this.deps.tokens.generate(), now);
  }
}

/** Thrown inside a unit of work when the session was revoked or ended after it was read; rolls the unit back. */
class SessionClosed extends Error {}

/** Thrown inside the grace unit of work to roll it back; the session is then revoked as for any reuse. */
class GraceRefused extends Error {}
