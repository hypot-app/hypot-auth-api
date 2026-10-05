import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { normalizeEmail } from '../domain/email';
import type { UserRepository } from '../domain/user.repository';
import type { ConfirmationIssuer } from './confirmation-issuer';

export interface ResendConfirmationInput {
  clientId: string;
  email: string;
}

export interface ResendConfirmationDeps {
  resolveClient: ResolveClientUseCase;
  users: UserRepository;
  confirmations: ConfirmationIssuer;
  uow: UnitOfWork;
}

/**
 * Sends a new confirmation link to an unconfirmed account and invalidates the old one.
 * The result is `ok` for an unknown address and for a confirmed account too, so it never
 * reveals which accounts exist.
 */
export class ResendConfirmationUseCase {
  constructor(private readonly deps: ResendConfirmationDeps) {}

  async execute(input: ResendConfirmationInput): Promise<Result<void, DomainError>> {
    const client = await this.deps.resolveClient.execute({ clientId: input.clientId });
    if (!client.ok) return err(client.error);
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);

    const user = await this.deps.users.findByAppAndEmail(client.value.id, email.value);
    if (user !== null && !user.isConfirmed()) {
      await this.deps.uow.run(() => this.deps.confirmations.issueFor(user));
    }
    return ok(undefined);
  }
}
