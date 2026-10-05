import type { DomainError } from '../../shared-kernel/domain-error';
import type { Result } from '../../shared-kernel/result';

/** Access tokens live one hour. They are not denylisted: logout and password change wait for `exp` (spec). */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** Protected header `typ` of every access token (RFC 9068): a token of another type is never accepted. */
export const ACCESS_TOKEN_TYP = 'at+jwt';

/** Claims of an access token. Roles belong to the apps, so none are carried. */
export interface AccessTokenClaims {
  /** Issuer URL of this service. */
  iss: string;
  /** The account id. */
  sub: string;
  /** The `client_id` of the app the token was issued to. */
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface IssueAccessTokenInput {
  accountId: string;
  clientId: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

/** Port: signs access tokens with the active key of the KeyStore. */
export interface AccessTokenIssuer {
  issue(input: IssueAccessTokenInput): Promise<IssuedAccessToken>;
}

/** The `client_id`(s) a verifier accepts as `aud`: one id, or a non-empty list. */
export type ExpectedAudience = string | readonly [string, ...string[]];

/**
 * Port: validates access tokens against every published key, by `kid`. Failure is always
 * the same `invalid_token` error, so a caller cannot learn why a token was refused.
 * The expected audience is mandatory: a token for app A must never verify for app B.
 * A missing or empty audience is a programming error and throws a `TypeError`.
 */
export interface AccessTokenVerifier {
  verify(token: string, options: { audience: ExpectedAudience }): Promise<Result<AccessTokenClaims, DomainError>>;
}

export const ACCESS_TOKEN_ISSUER = Symbol('AccessTokenIssuer');
export const ACCESS_TOKEN_VERIFIER = Symbol('AccessTokenVerifier');
