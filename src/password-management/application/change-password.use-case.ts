import { randomUUID } from 'node:crypto';
import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import { ClientRef } from '../../abuse-protection/domain/client-ref';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { isUuid } from '../../shared-kernel/uuid';
import type { AuthenticateBearerInput, AuthenticatedBearer } from '../../token-lifecycle/application/authenticate-bearer.use-case';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import type { PasswordHasher } from '../../user-accounts/domain/password-hasher';
import { validatePassword } from '../../user-accounts/domain/password-policy';
import type { UserRepository } from '../../user-accounts/domain/user.repository';

export interface ChangePasswordInput {
  /** The raw `Authorization` header, when present. */
  authorization: string | undefined;
  /** Browser `Origin` header, when present; the bearer check binds it to the token's app (ADR 38). */
  origin?: string;
  /** Raw JSON body values, so their shape is checked after the bearer (spec order of checks). */
  currentPassword: unknown;
  newPassword: unknown;
  ip: ClientIp;
}

/**
 * `unauthorized` is a bad bearer (the HTTP layer answers `401`). Every other kind is a `400` the caller can
 * read: a wrong current password is `invalid_current_password`, never a `401`, so a client can tell it from an
 * expired access token and never refreshes in a loop.
 */
export type ChangeFailure =
  | { kind: 'unauthorized' }
  | { kind: 'invalid_request' }
  | { kind: 'invalid_password'; error: DomainError }
  | { kind: 'invalid_current_password' };

export interface ChangePasswordDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  authenticate: { execute(input: AuthenticateBearerInput): Promise<Result<AuthenticatedBearer, DomainError>> };
  users: UserRepository;
  hasher: PasswordHasher;
  /** `RevokeAccountSessionsUseCase`: joins the unit of work that is running. */
  sessions: { execute(input: { userId: string; reason: 'password_changed' }): Promise<number> };
  outbox: EmailOutbox;
  clock: Clock;
  uow: UnitOfWork;
}

const fail = (failure: ChangeFailure) => err<ChangeFailure>(failure);

/** The stored hash is no longer the one that was verified; thrown inside the unit of work to roll it back. */
class PasswordChangedMidRequest extends Error {}

/**
 * Changes the password of the account behind a bearer access token. Order of checks (spec): the bearer, the
 * body shape, the new-password rules (no counter touched), the lockout state, then the current password.
 *
 * The lockout is the login one: the attempt is counted on BOTH counters (pair and account, keyed like login)
 * before bcrypt runs, and a blocked or locked caller gets the same `invalid_current_password` even with the
 * correct password, without bcrypt. A success refunds the pair counter only. Change has no per-IP limit of its
 * own. A password that changed under the request (a reset or change committed while bcrypt ran) is refused as
 * `invalid_current_password` with nothing written, and is not counted as a wrong guess. On success the hash,
 * every session of the account (the caller's too; their access token lives until `exp`) and the
 * password-changed notice commit together.
 */
export class ChangePasswordUseCase {
  constructor(private readonly deps: ChangePasswordDeps) {}

  async execute(input: ChangePasswordInput): Promise<Result<void, ChangeFailure>> {
    const { abuse, users, hasher } = this.deps;
    const bearer = await this.deps.authenticate.execute({ authorization: input.authorization, origin: input.origin });
    if (!bearer.ok) return fail({ kind: 'unauthorized' });
    // A validly signed token can still carry any `sub`; a non-UUID would make Postgres fail the query (a 500).
    if (!isUuid(bearer.value.accountId)) return fail({ kind: 'unauthorized' });

    if (typeof input.currentPassword !== 'string' || typeof input.newPassword !== 'string') {
      return fail({ kind: 'invalid_request' });
    }
    const newPassword = validatePassword(input.newPassword);
    if (!newPassword.ok) return fail({ kind: 'invalid_password', error: newPassword.error });

    const user = await users.findByIdInApp(bearer.value.appId, bearer.value.accountId);
    const app = await this.deps.resolveClient.execute({ clientId: bearer.value.clientId });
    // An account that is gone, or a token whose app went inactive since the check, is a bad bearer.
    if (user === null || !app.ok) return fail({ kind: 'unauthorized' });

    const client = ClientRef.resolved(app.value);
    // Counted BEFORE bcrypt, exactly as login does, so parallel guesses cannot outrun the lockout.
    if ((await abuse.beginLoginAttempt(client, user.email, input.ip)) === 'blocked') {
      return fail({ kind: 'invalid_current_password' });
    }
    // bcrypt ignores everything after a NUL or past 72 bytes, so such a password is compared as '' (as login does).
    const current = validatePassword(input.currentPassword);
    if (!(await hasher.verify(current.ok ? current.value : '', user.passwordHash))) {
      return fail({ kind: 'invalid_current_password' });
    }

    const passwordHash = await hasher.hash(newPassword.value);
    try {
      await this.deps.uow.run(async () => {
        const now = this.deps.clock.now();
        // Compare-and-swap on the hash verified above: bcrypt took a while since the read, and a reset or change
        // that committed meanwhile must not be silently overwritten by the holder of the old password.
        if (!(await users.replacePassword(user.id, user.passwordHash, passwordHash, now))) throw new PasswordChangedMidRequest();
        await this.deps.sessions.execute({ userId: user.id, reason: 'password_changed' });
        await this.deps.outbox.save(
          OutboxEmail.queue({ id: randomUUID(), appId: user.appId, to: user.email, template: 'password-changed', payload: {}, now }),
        );
      });
    } catch (error) {
      if (!(error instanceof PasswordChangedMidRequest)) throw error;
      // Nothing was written, revoked or queued. The caller proved the password they read, so this is not a wrong
      // guess: the pair counter is refunded like on a success (the account counter keeps the attempt).
      await abuse.recordLoginSuccess(client, user.email, input.ip);
      return fail({ kind: 'invalid_current_password' });
    }
    // Refunded only once the change is committed: a change that fails to commit stays counted.
    await abuse.recordLoginSuccess(client, user.email, input.ip);
    return ok(undefined);
  }
}
