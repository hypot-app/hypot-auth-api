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
 * reveals which accounts exist. The IP limit runs before the account is looked up. The per-account cap counts
 * only an email that is about to be queued, so it is hit after the lookup and only for an unconfirmed account;
 * past it nothing is issued or queued and the current token stays valid.
 */
export class ResendConfirmationUseCase {
  constructor(private readonly deps: ResendConfirmationDeps) {}

  async execute(input: ResendConfirmationInput): Promise<Result<void, DomainError>> {
    const admitted = await admitEmailRequest(this.deps, input);
    if (!admitted.ok) return err(admitted.error);
    const { app, client } = admitted.value;
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);

    const user = await this.deps.users.findByAppAndEmail(app.id, email.value);
    // A request that queues nothing (unknown or confirmed address) never touches the cap (ADR 36).
    if (user === null || user.isConfirmed()) return ok(undefined);
    const cap = await this.deps.abuse.checkEmailAccount(client, email.value);
    if (cap.kind === 'account_suppressed') return ok(undefined);

    await this.deps.uow.run(() => this.deps.confirmations.issueFor(user));
    return ok(undefined);
  }
}
