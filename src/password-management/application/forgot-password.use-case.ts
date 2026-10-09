import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { admitEmailRequest } from '../../user-accounts/application/email-request-gate';
import type { ConfirmationIssuer } from '../../user-accounts/application/confirmation-issuer';
import { normalizeEmail } from '../../user-accounts/domain/email';
import type { UserRepository } from '../../user-accounts/domain/user.repository';
import type { PasswordResetIssuer } from './password-reset-issuer';

export interface ForgotPasswordInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin?: string;
  email: string;
  ip: ClientIp;
}

export interface ForgotPasswordDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  users: UserRepository;
  confirmations: ConfirmationIssuer;
  resets: PasswordResetIssuer;
  uow: UnitOfWork;
}

/**
 * Starts a password reset. The result is `ok` whether the address is confirmed, unconfirmed, unknown or
 * only registered in another app, so it never reveals which accounts exist.
 *
 * Order: the client with its origin binding, the unconfigured-client check and the per-IP limit (shared with
 * signup and resend, before any lookup), then the account. A confirmed account gets a reset token; an
 * unconfirmed one gets a new confirmation token instead (a reset could not be used to log in) and never a
 * reset token. The per-account email cap is hit only when an email is about to be queued, so a request for an
 * unknown address uses no budget (ADR 36); past the cap nothing is issued and the latest link stays valid.
 */
export class ForgotPasswordUseCase {
  constructor(private readonly deps: ForgotPasswordDeps) {}

  async execute(input: ForgotPasswordInput): Promise<Result<void, DomainError>> {
    const admitted = await admitEmailRequest(this.deps, input);
    if (!admitted.ok) return err(admitted.error);
    const { app, client } = admitted.value;
    const email = normalizeEmail(input.email);
    if (!email.ok) return err(email.error);

    const user = await this.deps.users.findByAppAndEmail(app.id, email.value);
    if (user === null) return ok(undefined);
    const cap = await this.deps.abuse.checkEmailAccount(client, email.value);
    if (cap.kind === 'account_suppressed') return ok(undefined);

    await this.deps.uow.run(() =>
      user.isConfirmed() ? this.deps.resets.issueFor(user) : this.deps.confirmations.issueFor(user),
    );
    return ok(undefined);
  }
}
