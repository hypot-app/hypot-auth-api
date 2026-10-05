import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';
import type { Clock } from '../../shared-kernel/clock';
import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import {
  ACCESS_TOKEN_TYP,
  type AccessTokenClaims,
  type AccessTokenVerifier,
  type ExpectedAudience,
} from '../domain/access-token';
import type { KeyStore } from '../domain/key-store';

/** A 2048-bit RS256 access token is about 500 characters; anything near this cap is not ours. */
const MAX_TOKEN_LENGTH = 4096;
const CLOCK_TOLERANCE_SECONDS = 5;
const REQUIRED_CLAIMS = ['iss', 'sub', 'aud', 'iat', 'exp', 'jti'];

export class JoseAccessTokenVerifier implements AccessTokenVerifier {
  private readonly clock: Clock;
  private readonly issuer: string;
  private readonly resolveKey: ReturnType<typeof createLocalJWKSet>;

  constructor(deps: { keyStore: KeyStore; clock: Clock; issuer: string }) {
    this.clock = deps.clock;
    this.issuer = deps.issuer;
    // The published set is the only source of verification keys: active, next and retired.
    this.resolveKey = createLocalJWKSet(deps.keyStore.publicJwks() as JSONWebKeySet);
  }

  async verify(token: string, options: { audience: ExpectedAudience }): Promise<Result<AccessTokenClaims, DomainError>> {
    const audience = options?.audience;
    // jose skips the aud check when audience is undefined or empty: refuse instead of verifying for "any app".
    if (audience === undefined || audience.length === 0) {
      throw new TypeError('An expected audience (client_id or a non-empty list) is required to verify an access token');
    }
    try {
      if (token.length > MAX_TOKEN_LENGTH) throw new Error('token too long');
      // Without a kid jose would pick the only key of a one-key set; every token must name its key.
      if (typeof decodeProtectedHeader(token).kid !== 'string') throw new Error('missing kid');

      const { payload } = await jwtVerify(token, this.resolveKey, {
        algorithms: ['RS256'], // pinned: no alg confusion, no `none`
        typ: ACCESS_TOKEN_TYP, // explicit typing: an id+jwt or an untyped JWT from the same key is refused
        issuer: this.issuer,
        audience: typeof audience === 'string' ? audience : [...audience],
        currentDate: this.clock.now(),
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: REQUIRED_CLAIMS,
      });
      return ok(payload as unknown as AccessTokenClaims);
    } catch {
      // The reason is deliberately dropped: it must not become an oracle for token forgers.
      return err(new DomainError('invalid_token', 'Invalid access token'));
    }
  }
}
