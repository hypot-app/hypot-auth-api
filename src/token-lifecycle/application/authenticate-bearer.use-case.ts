import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { AccessTokenVerifier } from '../domain/access-token';
import { unverifiedAudience } from '../domain/unverified-audience';

export interface AuthenticateBearerInput {
  /** The raw `Authorization` header, when present. */
  authorization: string | undefined;
  /** Browser `Origin` header, when present; it must belong to the token's app (ADR 38). */
  origin: string | undefined;
}

/** Who a valid bearer token speaks for. */
export interface AuthenticatedBearer {
  /** The token's `sub`. */
  accountId: string;
  /** Internal id of the app the token was issued to. */
  appId: string;
  /** The token's `aud`. */
  clientId: string;
}

export interface AuthenticateBearerDeps {
  resolveClient: ResolveClientUseCase;
  verifier: AccessTokenVerifier;
}

/** One error for every cause: a caller must not learn why a token was refused. */
const UNAUTHORIZED_CODE = 'unauthorized';
const UNAUTHORIZED_MESSAGE = 'Missing or invalid access token';

/** RFC 6750 `Bearer` followed by a token68 value; the scheme is case-insensitive. */
const BEARER_HEADER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

const unauthorized = () => err(new DomainError(UNAUTHORIZED_CODE, UNAUTHORIZED_MESSAGE));

/**
 * Authenticates a bearer access token (ADR 32 audience flow). The token names its own app: `aud` is
 * read from the unverified payload only to pick the expectation, the app must be active, the token must
 * verify with exactly that audience, and only then is the request `Origin` bound to that app.
 */
export class AuthenticateBearerUseCase {
  constructor(private readonly deps: AuthenticateBearerDeps) {}

  async execute(input: AuthenticateBearerInput): Promise<Result<AuthenticatedBearer, DomainError>> {
    const token = input.authorization === undefined ? undefined : BEARER_HEADER.exec(input.authorization)?.[1];
    if (token === undefined) return unauthorized();

    const audience = unverifiedAudience(token);
    if (audience === null) return unauthorized();

    // Unknown and inactive apps end here, before any signature work.
    const client = await this.deps.resolveClient.execute({ clientId: audience });
    if (!client.ok) return unauthorized();

    const claims = await this.deps.verifier.verify(token, { audience });
    if (!claims.ok) return unauthorized();

    // Bind last, so the origin check never runs for a token that is not ours.
    if (input.origin !== undefined) {
      const bound = await this.deps.resolveClient.execute({ clientId: audience, origin: input.origin });
      if (!bound.ok) return unauthorized();
    }
    return ok({ accountId: claims.value.sub, appId: client.value.id, clientId: audience });
  }
}
