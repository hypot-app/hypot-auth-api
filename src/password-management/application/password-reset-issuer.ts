import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared-kernel/clock';
import type { TokenGenerator } from '../../shared-kernel/token-generator';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import { OneTimeToken } from '../../user-accounts/domain/one-time-token';
import type { OneTimeTokenRepository } from '../../user-accounts/domain/one-time-token.repository';
import type { User } from '../../user-accounts/domain/user';

export interface PasswordResetIssuerDeps {
  tokens: TokenGenerator;
  oneTimeTokens: OneTimeTokenRepository;
  outbox: EmailOutbox;
  clock: Clock;
}

/**
 * Issues a password-reset token and queues the email that carries it. The counterpart of the confirmation
 * issuer: the caller runs it inside its unit of work, so the superseded tokens, the new token and the
 * outbox row commit together or not at all.
 */
export class PasswordResetIssuer {
  constructor(private readonly deps: PasswordResetIssuerDeps) {}

  async issueFor(user: User): Promise<void> {
    const now = this.deps.clock.now();
    const { token, hash } = this.deps.tokens.generate();
    // Only the newest link works (spec: a new forgot invalidates earlier unused reset tokens).
    await this.deps.oneTimeTokens.invalidateOutstanding(user.id, 'password_reset', now);
    await this.deps.oneTimeTokens.save(
      OneTimeToken.issue({ id: randomUUID(), userId: user.id, purpose: 'password_reset', tokenHash: hash, now }),
    );
    await this.deps.outbox.save(
      OutboxEmail.queue({
        id: randomUUID(),
        appId: user.appId,
        to: user.email,
        template: 'password-reset',
        payload: { token },
        now,
      }),
    );
  }
}
