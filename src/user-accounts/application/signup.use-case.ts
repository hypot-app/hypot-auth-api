import { randomUUID } from 'node:crypto';
import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import { normalizeEmail } from '../domain/email';
import type { PasswordHasher } from '../domain/password-hasher';
import { validatePassword } from '../domain/password-policy';
import { User } from '../domain/user';
import type { UserRepository } from '../domain/user.repository';
import type { ConfirmationIssuer } from './confirmation-issuer';
import { admitEmailRequest } from './email-request-gate';

export interface SignupInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin?: string;
  email: string;
  password: string;
  ip: ClientIp;
}

export interface SignupDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
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
 * to the outbox inside one transaction. The IP limit and the client checks come first (see
 * `admitEmailRequest`); validation failures after them depend only on the caller's own input.
 *
 * The per-account email cap counts only an email that is about to be queued (ADR 36); signup queues exactly one
 * email on both outcomes, so it is hit once per request after the password is hashed and BEFORE the unit of
 * work (see the comment at the hit). Past it the answer is the same `ok`, the password is still hashed and the
 * account is still created, but no token is issued and no email is queued.
 */
export class SignupUseCase {
  constructor(private readonly deps: SignupDeps) {}

  async execute(input: SignupInput): Promise<Result<void, DomainError>> {
    const admitted = await admitEmailRequest(this.deps, input);
    if (!admitted.ok) return err(admitted.error);
    const { app, client } = admitted.value;
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);
    const password = validatePassword(input.password);
    if (!password.ok) return err(password.error);

    const passwordHash = await this.deps.hasher.hash(password.value);
    const now = this.deps.clock.now();
    const user = User.register({ id: randomUUID(), appId: app.id, email: email.value, passwordHash, now });

    // Either outcome (new account or duplicate) queues exactly one email, so every request that reaches this
    // point counts once, and no outcome-dependent knowledge is needed. The hit must stay OUTSIDE the unit of work:
    // the counter store uses its own pool connection, and a hit inside the transaction would need a second
    // connection while holding the first, which deadlocks the pool under concurrent signups.
    const cap = await this.deps.abuse.checkEmailAccount(client, email.value);
    const queueEmail = cap.kind === 'allowed';

    await this.deps.uow.run(async () => {
      const created = await this.deps.users.add(user);
      if (!queueEmail) return;
      if (created) {
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
