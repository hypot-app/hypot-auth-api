import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import { normalizeEmail } from '../domain/email';
import type { PasswordHasher } from '../domain/password-hasher';
import { validatePassword } from '../domain/password-policy';
import { User } from '../domain/user';
import type { UserRepository } from '../domain/user.repository';
import type { ConfirmationIssuer } from './confirmation-issuer';

export interface SignupInput {
  clientId: string;
  email: string;
  password: string;
}

export interface SignupDeps {
  resolveClient: ResolveClientUseCase;
  users: UserRepository;
  hasher: PasswordHasher;
  confirmations: ConfirmationIssuer;
  outbox: EmailOutbox;
  clock: Clock;
  uow: UnitOfWork;
}

/**
 * Registers an account. The result never says whether the address was already taken:
 * a duplicate returns the same `ok` as a new account, and the existing owner gets an
 * `account-exists` notice instead of a confirmation link.
 *
 * Timing: the password is hashed before the account is inserted, on both paths, so a
 * duplicate costs the same bcrypt work as a new account (ADR 12). Both paths then write
 * to the outbox inside one transaction. Validation failures come first and depend only on
 * the caller's own input.
 */
export class SignupUseCase {
  constructor(private readonly deps: SignupDeps) {}

  async execute(input: SignupInput): Promise<Result<void, DomainError>> {
    const client = await this.deps.resolveClient.execute({ clientId: input.clientId });
    if (!client.ok) return err(client.error);
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);
    const password = validatePassword(input.password);
    if (!password.ok) return err(password.error);

    const passwordHash = await this.deps.hasher.hash(password.value);
    const now = this.deps.clock.now();
    const user = User.register({ id: randomUUID(), appId: client.value.id, email: email.value, passwordHash, now });

    await this.deps.uow.run(async () => {
      if (await this.deps.users.add(user)) {
        await this.deps.confirmations.issueFor(user);
      } else {
        await this.deps.outbox.save(
          OutboxEmail.queue({
            id: randomUUID(),
            appId: user.appId,
            to: user.email,
            template: 'account-exists',
            payload: {},
            now,
          }),
        );
      }
    });
    return ok(undefined);
  }
}
