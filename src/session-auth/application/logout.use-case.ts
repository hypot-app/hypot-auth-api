import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import { hashToken, isWellFormedToken } from '../../shared-kernel/token-generator';
import type { SessionRepository } from '../domain/session.repository';

export interface LogoutInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin: string | undefined;
  refreshToken: string;
}

/**
 * What a logout reports. It never says whether anything was revoked: `clientBound` is only the fact the
 * HTTP layer needs to decide the CORS grant (ADR 38) - the client resolved and its origin is bound to it.
 */
export interface LogoutOutcome {
  clientBound: boolean;
}

export interface LogoutDeps {
  resolveClient: ResolveClientUseCase;
  sessions: Pick<SessionRepository, 'findTokenState' | 'revoke'>;
  clock: Clock;
}

/**
 * Revokes the session of a refresh token (ADR 35). It is idempotent and has no oracle: every outcome is
 * the same `204` to the caller. A session is revoked only when the token belongs to the client's app AND
 * any `Origin` is bound to that app; the token may be active, used, revoked or expired.
 */
export class LogoutUseCase {
  constructor(private readonly deps: LogoutDeps) {}

  async execute(input: LogoutInput): Promise<LogoutOutcome> {
    const client = await this.deps.resolveClient.execute({ clientId: input.clientId, origin: input.origin });
    // Unknown, inactive and origin-unbound clients end here: no lookup, no effect.
    if (!client.ok) return { clientBound: false };
    if (!isWellFormedToken(input.refreshToken)) return { clientBound: true };

    const state = await this.deps.sessions.findTokenState(hashToken(input.refreshToken));
    if (state !== null && state.appId === client.value.id) {
      await this.deps.sessions.revoke(state.sessionId, 'logout', this.deps.clock.now());
    }
    return { clientBound: true };
  }
}
