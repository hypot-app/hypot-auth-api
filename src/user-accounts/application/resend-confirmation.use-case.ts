import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { normalizeEmail } from '../domain/email';
import type { UserRepository } from '../domain/user.repository';
import type { ConfirmationIssuer } from './confirmation-issuer';
import { admitEmailRequest } from './email-request-gate';

export interface ResendConfirmationInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin?: string;
  email: string;
  ip: ClientIp;
}

export interface ResendConfirmationDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  users: UserRepository;
  confirmations: ConfirmationIssuer;
  uow: UnitOfWork;
}

/**
 * Sends a new confirmation link to an unconfirmed account and invalidates the old one.
 * The result is `ok` for an unknown address and for a confirmed account too, so it never
 * reveals which accounts exist. The IP limit and the per-account cap run before the account is looked up;
 * the cap counts requests for unknown addresses too, and past it nothing is issued or queued.
 */
export class ResendConfirmationUseCase {
  constructor(private readonly deps: ResendConfirmationDeps) {}

  async execute(input: ResendConfirmationInput): Promise<Result<void, DomainError>> {
    const admitted = await admitEmailRequest(this.deps, input);
    if (!admitted.ok) return err(admitted.error);
    const { app, client } = admitted.value;
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);
    const cap = await this.deps.abuse.checkEmailAccount(client, email.value);
    if (cap.kind === 'account_suppressed') return ok(undefined);

    const user = await this.deps.users.findByAppAndEmail(app.id, email.value);
    if (user !== null && !user.isConfirmed()) {
      await this.deps.uow.run(() => this.deps.confirmations.issueFor(user));
    }
    return ok(undefined);
  }
}
