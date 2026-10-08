import type { Clock } from '../../shared-kernel/clock';
import type { SessionRevokedReason } from '../domain/session';
import type { SessionRepository } from '../domain/session.repository';

export interface RevokeAccountSessionsInput {
  userId: string;
  reason: SessionRevokedReason;
}

export interface RevokeAccountSessionsDeps {
  sessions: Pick<SessionRepository, 'revokeAllForUser'>;
  clock: Clock;
}

/**
 * Ends every active session of one account (ADR 35). Exported for password-management, which calls it in
 * the same unit of work as the password write: the repository joins the transaction that is running.
 */
export class RevokeAccountSessionsUseCase {
  constructor(private readonly deps: RevokeAccountSessionsDeps) {}

  /** Returns how many sessions it revoked. */
  execute(input: RevokeAccountSessionsInput): Promise<number> {
    return this.deps.sessions.revokeAllForUser(input.userId, input.reason, this.deps.clock.now());
  }
}
