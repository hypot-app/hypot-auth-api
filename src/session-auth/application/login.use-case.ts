import { randomUUID } from 'node:crypto';
import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import { ClientRef } from '../../abuse-protection/domain/client-ref';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { TokenGenerator } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from '../../token-lifecycle/domain/access-token';
import { normalizeEmail } from '../../user-accounts/domain/email';
import type { PasswordHasher } from '../../user-accounts/domain/password-hasher';
import { validatePassword } from '../../user-accounts/domain/password-policy';
import type { UserRepository } from '../../user-accounts/domain/user.repository';
import { RefreshToken } from '../domain/refresh-token';
import { Session } from '../domain/session';
import type { SessionRepository } from '../domain/session.repository';

/**
 * Counter key for an email that is not an email at all. Such a request can never succeed, so all of
 * them share one pair and one account counter instead of one row per attacker-chosen string.
 */
const MALFORMED_EMAIL_KEY = '';

export interface LoginInput {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin: string | undefined;
  email: string;
  password: string;
  ip: ClientIp;
}

export interface LoginTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

/**
 * The one login failure. `clientBound` says whether the client resolved and its origin was bound to
 * it, which is the only fact the HTTP layer may use (to decide the CORS grant, ADR 38); the cause of
 * the failure is never exposed.
 */
export interface LoginFailure {
  clientBound: boolean;
}

export interface LoginDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  users: UserRepository;
  hasher: PasswordHasher;
  /** Hash of a password nobody has, made at boot with the real cost; compared when there is no account. */
  dummyHash: string;
  sessions: Pick<SessionRepository, 'open'>;
  tokens: TokenGenerator;
  accessTokens: AccessTokenIssuer;
  clock: Clock;
  uow: UnitOfWork;
  ttls: { idleSeconds: number; absoluteSeconds: number };
}

/**
 * Password login (ADR 34). Every request that the limits let through costs exactly one bcrypt
 * comparison, against the account's hash or the dummy hash, with no early return, and every failure
 * is the same `LoginFailure`. A request that a limit or a block rejects is answered before bcrypt
 * (CPU protection): unknown emails are counted and blocked the same way, so that reveals nothing.
 * The limiter store failing throws `TemporarilyUnavailable` (it never fails open).
 */
export class LoginUseCase {
  constructor(private readonly deps: LoginDeps) {}

  async execute(input: LoginInput): Promise<Result<LoginTokens, LoginFailure>> {
    const { abuse, users, hasher } = this.deps;
    const resolved = await this.deps.resolveClient.execute({ clientId: input.clientId, origin: input.origin });
    const clientBound = resolved.ok;
    // Only a resolved app gets its own counters; every other client_id shares the sentinel.
    const client = resolved.ok ? ClientRef.resolved(resolved.value) : ClientRef.unknown();
    const failure = err<LoginFailure>({ clientBound });

    const email = normalizeEmail(input.email);
    const emailKey = email.ok ? email.value : MALFORMED_EMAIL_KEY;

    if (!(await abuse.checkLoginIp(client, input.ip))) return failure;
    // Counted BEFORE bcrypt and before the lookup, so parallel guesses cannot outrun the lockout.
    if ((await abuse.beginLoginAttempt(client, emailKey, input.ip)) === 'blocked') return failure;

    const user = resolved.ok && email.ok ? await users.findByAppAndEmail(resolved.value.id, email.value) : null;
    // bcrypt ignores everything after a NUL or past 72 bytes, so such a password is compared as ''.
    const password = validatePassword(input.password);
    const matches = await hasher.verify(password.ok ? password.value : '', user?.passwordHash ?? this.deps.dummyHash);
    if (user === null || !matches || !user.isConfirmed() || !resolved.ok) return failure;

    await abuse.recordLoginSuccess(client, emailKey, input.ip);
    return ok(await this.issueSession(resolved.value.id, resolved.value.clientId, user.id));
  }

  /** The session, its first token and the access token succeed or fail together. */
  private issueSession(appId: string, clientId: string, userId: string): Promise<LoginTokens> {
    const { sessions, tokens, accessTokens, clock, ttls } = this.deps;
    return this.deps.uow.run(async () => {
      const now = clock.now();
      const session = Session.open({ id: randomUUID(), appId, userId, now, absoluteTtlSeconds: ttls.absoluteSeconds });
      const refresh = tokens.generate();
      await sessions.open(session, RefreshToken.issue({ tokenHash: refresh.hash, session, now, idleTtlSeconds: ttls.idleSeconds }));
      const access = await accessTokens.issue({ accountId: userId, clientId });
      return { accessToken: access.token, expiresIn: ACCESS_TOKEN_TTL_SECONDS, refreshToken: refresh.token };
    });
  }
}
