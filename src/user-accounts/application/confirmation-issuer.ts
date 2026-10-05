import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared-kernel/clock';
import type { TokenGenerator } from '../../shared-kernel/token-generator';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import { OneTimeToken } from '../domain/one-time-token';
import type { OneTimeTokenRepository } from '../domain/one-time-token.repository';
import type { User } from '../domain/user';

export interface ConfirmationIssuerDeps {
  tokens: TokenGenerator;
  oneTimeTokens: OneTimeTokenRepository;
  outbox: EmailOutbox;
  clock: Clock;
}

/**
 * Issues a confirmation token and queues the email that carries it. Writes go through
 * the repositories, so the caller runs this inside its unit of work: the token and the
 * outbox row commit together or not at all. The email is queued, never sent inline.
 */
export class ConfirmationIssuer {
  constructor(private readonly deps: ConfirmationIssuerDeps) {}

  async issueFor(user: User): Promise<void> {
    const now = this.deps.clock.now();
    const { token, hash } = this.deps.tokens.generate();
    // Only the newest link works (spec: resending invalidates previous unused tokens).
    await this.deps.oneTimeTokens.invalidateOutstanding(user.id, 'email_verification', now);
    await this.deps.oneTimeTokens.save(
      OneTimeToken.issue({ id: randomUUID(), userId: user.id, purpose: 'email_verification', tokenHash: hash, now }),
    );
    await this.deps.outbox.save(
      OutboxEmail.queue({
        id: randomUUID(),
        appId: user.appId,
        to: user.email,
        template: 'confirmation',
        payload: { token },
        now,
      }),
    );
  }
}
