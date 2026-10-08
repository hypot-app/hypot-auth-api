import type { Clock } from '../../shared-kernel/clock';
import type { SessionRepository } from '../domain/session.repository';

export interface RevokeAllSessionsDeps {
  sessions: Pick<SessionRepository, 'revokeAll'>;
  clock: Clock;
}

/**
 * Ends every open session of every account and app (`ops:revoke-all`, the key-compromise procedure).
 * Access tokens already issued stay valid until `exp`; rotating the signing key is what ends those.
 */
export class RevokeAllSessionsUseCase {
  constructor(private readonly deps: RevokeAllSessionsDeps) {}

  /** Returns how many sessions it revoked. */
  execute(): Promise<number> {
    return this.deps.sessions.revokeAll('ops_revoke_all', this.deps.clock.now());
  }
}
