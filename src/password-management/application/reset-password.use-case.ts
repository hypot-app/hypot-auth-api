import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import { hashToken, isWellFormedToken } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { originBelongsToApp } from '../../user-accounts/application/token-origin-binding';
import type { OneTimeTokenRepository } from '../../user-accounts/domain/one-time-token.repository';
import type { PasswordHasher } from '../../user-accounts/domain/password-hasher';
import { validatePassword } from '../../user-accounts/domain/password-policy';
import type { UserRepository } from '../../user-accounts/domain/user.repository';

export interface ResetPasswordInput {
  /** Raw JSON body value, so it is checked before it is hashed. */
  token: unknown;
  newPassword: string;
  /** Browser `Origin` header, when present; it must belong to the token's app (ADR 38). */
  origin?: string;
  ip: ClientIp;
}

/**
 * `invalid_link` is the one answer for a malformed, unknown, used, expired, superseded, wrong-purpose or
 * origin-unbound token. `clientBound` says whether the origin was bound to the token's app, which is the only
 * fact the HTTP layer may use to decide the CORS grant (ADR 38, 40): the cause is never exposed.
 */
export type ResetFailure =
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid_password'; error: DomainError }
  | { kind: 'invalid_link'; clientBound: boolean };

export interface ResetPasswordDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  oneTimeTokens: OneTimeTokenRepository;
  users: UserRepository;
  hasher: PasswordHasher;
  /** `RevokeAccountSessionsUseCase`: joins the unit of work that is running. */
  sessions: { execute(input: { userId: string; reason: 'password_reset' }): Promise<number> };
  clock: Clock;
  uow: UnitOfWork;
}

/** Thrown inside the unit of work so a token consumed for a missing account rolls back with it. */
class InvalidLink extends Error {}

/**
 * Sets a new password from an emailed reset token. Order: the new password is validated first (it needs no
 * state, and a weak password must leave the token usable), then the per-IP limit before any token lookup, then
 * the token's app is looked up and the origin is bound to it BEFORE the token is consumed (so neither a flood
 * nor a foreign page can burn a valid token), then one unit of work: consume the token, write the hash, revoke
 * every session of the account. bcrypt runs only for a token that exists, and before the unit of work, so no
 * transaction waits on it.
 */
export class ResetPasswordUseCase {
  constructor(private readonly deps: ResetPasswordDeps) {}

  async execute(input: ResetPasswordInput): Promise<Result<void, ResetFailure>> {
    const password = validatePassword(input.newPassword);
    if (!password.ok) return err({ kind: 'invalid_password', error: password.error });

    const decision = await this.deps.abuse.checkIp('reset_ip', input.ip);
    if (decision.kind === 'ip_limited') return err({ kind: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds });

    const { token } = input;
    if (!isWellFormedToken(token)) return invalidLink(false);
    const hash = hashToken(token);
    // Read-only and before bcrypt: a token that does not exist costs no hashing, and the origin is bound to
    // the token's app before anything is consumed.
    const owner = await this.deps.oneTimeTokens.findAppByTokenHash(hash, 'password_reset');
    if (owner === null) return invalidLink(false);
    if (input.origin !== undefined && !(await originBelongsToApp(this.deps.resolveClient, owner, input.origin))) {
      return invalidLink(false);
    }
    const clientBound = input.origin !== undefined;

    const passwordHash = await this.deps.hasher.hash(password.value);
    try {
      await this.deps.uow.run(async () => {
        const now = this.deps.clock.now();
        const consumed = await this.deps.oneTimeTokens.consumeByHash(hash, 'password_reset', now);
        if (consumed === null) throw new InvalidLink();
        if (!(await this.deps.users.updatePassword(consumed.userId, passwordHash, now))) throw new InvalidLink();
        await this.deps.sessions.execute({ userId: consumed.userId, reason: 'password_reset' });
      });
    } catch (error) {
      if (error instanceof InvalidLink) return invalidLink(clientBound);
      throw error;
    }
    return ok(undefined);
  }
}

const invalidLink = (clientBound: boolean) => err<ResetFailure>({ kind: 'invalid_link', clientBound });
