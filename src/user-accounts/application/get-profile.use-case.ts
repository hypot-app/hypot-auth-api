import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import {
  UNAUTHORIZED_CODE,
  UNAUTHORIZED_MESSAGE,
  type AuthenticateBearerInput,
  type AuthenticatedBearer,
} from '../../token-lifecycle/application/authenticate-bearer.use-case';
import type { User } from '../domain/user';
import type { UserRepository } from '../domain/user.repository';

export interface GetProfileDeps {
  authenticate: { execute(input: AuthenticateBearerInput): Promise<Result<AuthenticatedBearer, DomainError>> };
  users: Pick<UserRepository, 'findByIdInApp'>;
}

/**
 * The account behind a bearer token. A token whose account is gone, or belongs to another app than
 * the token's `aud`, is the same `unauthorized` as any bad token: the caller learns nothing more.
 */
export class GetProfileUseCase {
  constructor(private readonly deps: GetProfileDeps) {}

  async execute(input: AuthenticateBearerInput): Promise<Result<User, DomainError>> {
    const bearer = await this.deps.authenticate.execute(input);
    if (!bearer.ok) return bearer;
    const user = await this.deps.users.findByIdInApp(bearer.value.appId, bearer.value.accountId);
    if (user === null) return err(new DomainError(UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE));
    return ok(user);
  }
}
