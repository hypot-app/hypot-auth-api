import { randomUUID } from 'node:crypto';
import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { Clock } from '../../shared-kernel/clock';
import { err, ok, type Result } from '../../shared-kernel/result';
import { hashToken, isWellFormedToken } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { EmailOutbox } from '../../transactional-email/domain/email-outbox';
import { OutboxEmail } from '../../transactional-email/domain/outbox-email';
import type { OneTimeTokenRepository } from '../domain/one-time-token.repository';
import type { UserRepository } from '../domain/user.repository';

export interface ConfirmEmailInput {
  /** Raw JSON body value, so it is checked before it is hashed. */
  token: unknown;
  /** Browser `Origin` header, when present; it must belong to the token's app (ADR 38). */
  origin?: string;
  ip: ClientIp;
}

/**
 * `invalid_link` is the one answer for a malformed, unknown, used, expired, wrong-purpose or
 * origin-unbound token. `clientBound` says whether the origin was bound to the token's app, which is the
 * only fact the HTTP layer may use to decide the CORS grant: the cause of the failure is never exposed.
 */
export type ConfirmFailure =
  | { kind: 'rate_limited'; retryAfterSeconds: number }
  | { kind: 'invalid_link'; clientBound: boolean };

export interface ConfirmEmailDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
  oneTimeTokens: OneTimeTokenRepository;
  users: UserRepository;
  outbox: EmailOutbox;
  clock: Clock;
  uow: UnitOfWork;
}

const invalidLink = (clientBound: boolean) => err<ConfirmFailure>({ kind: 'invalid_link', clientBound });

/**
 * Confirms an account from an emailed token. The per-IP limit runs first, before any token lookup, and
 * the origin is bound to the token's app before the token is consumed, so neither a flood nor a foreign
 * page can burn a valid token (ADR 38, ADR 40).
 */
export class ConfirmEmailUseCase {
  constructor(private readonly deps: ConfirmEmailDeps) {}

  async execute(input: ConfirmEmailInput): Promise<Result<void, ConfirmFailure>> {
    const decision = await this.deps.abuse.checkIp('confirm_ip', input.ip);
    if (decision.kind === 'ip_limited') return err({ kind: 'rate_limited', retryAfterSeconds: decision.retryAfterSeconds });

    const { token } = input;
    if (!isWellFormedToken(token)) return invalidLink(false);
    const hash = hashToken(token);
    if (input.origin !== undefined && !(await this.originBoundToTokenApp(hash, input.origin))) return invalidLink(false);
    const clientBound = input.origin !== undefined;

    return this.deps.uow.run(async () => {
      const now = this.deps.clock.now();
      const consumed = await this.deps.oneTimeTokens.consumeByHash(hash, 'email_verification', now);
      if (consumed === null) return invalidLink(clientBound);
      const user = await this.deps.users.findById(consumed.userId);
      if (user === null) return invalidLink(clientBound);

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

  /** Read-only: an unknown token and a wrong origin are the same `false`, so the check is not a token oracle. */
  private async originBoundToTokenApp(hash: Buffer, origin: string): Promise<boolean> {
    const owner = await this.deps.oneTimeTokens.findAppByTokenHash(hash, 'email_verification');
    if (owner === null) return false;
    const client = await this.deps.resolveClient.execute({ clientId: owner.clientId, origin });
    return client.ok;
  }
}
