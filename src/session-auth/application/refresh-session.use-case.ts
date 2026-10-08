import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import { ClientRef } from '../../abuse-protection/domain/client-ref';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import { err, ok, type Result } from '../../shared-kernel/result';
import { hashToken, isWellFormedToken, type TokenGenerator } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from '../../token-lifecycle/domain/access-token';
import { hashClientIp } from '../domain/ip-hash';
import { RefreshToken } from '../domain/refresh-token';
import type { SessionRepository } from '../domain/session.repository';
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
  sessions: Pick<SessionRepository, 'consume' | 'findTokenState' | 'addToken' | 'touch' | 'revoke'>;
  tokens: TokenGenerator;
  accessTokens: AccessTokenIssuer;
  clock: Clock;
  uow: UnitOfWork;
  ttls: { idleSeconds: number; absoluteSeconds: number };
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
    const rotated = await this.deps.uow.run(async () => {
      const consumed = await sessions.consume(hash, app.id, now, successor.hash, hashClientIp(input.ip));
      if (consumed === null) return null;
      await sessions.addToken(
        RefreshToken.issue({
          tokenHash: successor.hash,
          session: { id: consumed.sessionId, expiresAt: consumed.sessionExpiresAt },
          now,
          idleTtlSeconds: this.deps.ttls.idleSeconds,
        }),
      );
      await sessions.touch(consumed.sessionId, now);
      const access = await this.deps.accessTokens.issue({ accountId: consumed.userId, clientId: app.clientId });
      return { accessToken: access.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken: successor.token };
    });
    if (rotated !== null) return ok(rotated);

    await this.revokeOnReuse(hash, app.id, now);
    return invalid;
  }

  /**
   * Nothing was consumed. A token that was used or revoked, of THIS app, is a reuse and ends its
   * session; anything else (unknown, another app, expired, session already over) changes nothing.
   */
  private async revokeOnReuse(hash: Buffer, appId: string, now: Date): Promise<void> {
    const { sessions } = this.deps;
    const state = await sessions.findTokenState(hash);
    if (state === null || state.appId !== appId) return;
    if (state.consumedAt === null && state.tokenRevokedAt === null) return;
    await sessions.revoke(state.sessionId, 'reuse_detected', now);
  }
}
