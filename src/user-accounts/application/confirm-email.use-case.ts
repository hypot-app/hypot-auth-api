import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared-kernel/clock';
import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import { hashToken, isWellFormedToken } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import type { OneTimeTokenRepository } from '../domain/one-time-token.repository';
import type { UserRepository } from '../domain/user.repository';

export interface ConfirmEmailDeps {
  oneTimeTokens: OneTimeTokenRepository;
  users: UserRepository;
  outbox: EmailOutbox;
  clock: Clock;
  uow: UnitOfWork;
}

/** One answer for a malformed, unknown, used, expired or wrong-purpose token. */
const invalidLink = () =>
  err(new DomainError('invalid_or_expired_link', 'The confirmation link is invalid or has expired'));

export class ConfirmEmailUseCase {
  constructor(private readonly deps: ConfirmEmailDeps) {}

  /** `token` is raw input from a query string, so it is checked before it is hashed. */
  async execute(token: unknown): Promise<Result<void, DomainError>> {
    if (!isWellFormedToken(token)) return invalidLink();

    return this.deps.uow.run(async () => {
      const now = this.deps.clock.now();
      const consumed = await this.deps.oneTimeTokens.consumeByHash(hashToken(token), 'email_verification', now);
      if (consumed === null) return invalidLink();
      const user = await this.deps.users.findById(consumed.userId);
      if (user === null) return invalidLink();

      await this.deps.users.markEmailVerified(user.id, now);
      await this.deps.outbox.save(
        OutboxEmail.queue({
          id: randomUUID(),
          appId: user.appId,
          to: user.email,
          template: 'welcome',
          payload: {},
          now,
        }),
      );
      return ok(undefined);
    });
  }
}
