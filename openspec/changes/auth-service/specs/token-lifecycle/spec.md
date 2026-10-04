# Token Lifecycle Specification

## Purpose

Issuance, validation, rotation, and revocation of RS256 access tokens and opaque refresh tokens, plus JWKS publication.

## Requirements

### Requirement: Access token format

Access tokens MUST be RS256-signed JWTs with a 1-hour lifetime. Claims MUST include `iss` (the Auth service issuer URL), `aud` (the app's `client_id`), `sub` (the account id), `iat`, `exp`, and `jti`. The JWT header MUST include `kid`. Tokens MUST NOT carry roles or permissions.

#### Scenario: Token claims
- GIVEN a successful code exchange for app A
- WHEN the access token is decoded
- THEN `aud` equals app A's `client_id`
- AND `iss` equals the configured issuer
- AND the header `kid` matches a key published in JWKS
- AND `exp - iat` equals 3600 seconds
- AND no `roles` claim is present

#### Scenario: Audience mismatch at the consumer
- GIVEN a token issued for app A
- WHEN app B validates it against JWKS
- THEN app B rejects it because `aud` differs from its own `client_id`

### Requirement: JWKS endpoint

The system MUST publish public keys at a JWKS endpoint (`/.well-known/jwks.json`) so apps validate tokens locally. During key rotation, it MUST publish both the current and previous keys until all tokens signed by the previous key have expired.

#### Scenario: Validate offline
- GIVEN a token and the JWKS document
- WHEN a consumer verifies the signature using the `kid`
- THEN verification succeeds with no call to any other Auth endpoint

#### Scenario: Key rotation
- GIVEN a new signing key is activated
- WHEN JWKS is fetched
- THEN both the new and the previous public keys appear
- AND new tokens carry the new `kid`
- AND private keys never appear in JWKS

### Requirement: Token endpoints

The system MUST expose `POST /oauth/token`, which accepts `grant_type=authorization_code` or `grant_type=refresh_token`, and `POST /oauth/revoke`. Any other `grant_type` MUST be rejected with an `unsupported_grant_type` error.

#### Scenario: Unsupported grant
- GIVEN a request to `POST /oauth/token` with `grant_type=password`
- WHEN it is processed
- THEN it is rejected with `unsupported_grant_type`

### Requirement: Refresh token storage

Refresh tokens MUST be opaque, generated with a cryptographically secure RNG (at least 32 bytes), stored only as a hash, bound to account, app, and a token family, and have a finite lifetime (assumption: 30 days, absolute).

#### Scenario: Database exposure
- GIVEN read access to the refresh token table
- WHEN rows are inspected
- THEN no usable refresh token value is present

### Requirement: Refresh rotation

Every successful refresh MUST issue a new access token and a new refresh token in the same family and MUST invalidate the presented refresh token.

#### Scenario: Normal rotation
- GIVEN a valid refresh token R1
- WHEN it is submitted to the token endpoint
- THEN a new access token and refresh token R2 are returned
- AND R1 is marked used

#### Scenario: Wrong app
- GIVEN a refresh token issued to app A
- WHEN app B presents it
- THEN the request fails with a generic invalid-grant error

### Requirement: Reuse detection with family revocation

If an already-used or revoked refresh token is presented, the system MUST revoke the entire token family and fail the request.

#### Scenario: Replay of a rotated token
- GIVEN R1 was rotated into R2, and R2 into R3
- WHEN R1 is presented again
- THEN the request fails
- AND R2 and R3 are revoked
- AND the user must authenticate again

#### Scenario: Expired token
- GIVEN an expired refresh token
- WHEN it is presented
- THEN the request fails with a generic invalid-grant error

### Requirement: Logout and revocation

Logout (`POST /oauth/revoke`) MUST revoke the presented refresh token's family. A password change or password reset MUST revoke all of the account's refresh tokens in that app. Access tokens are not denylisted; the up-to-1-hour window is accepted.

#### Scenario: Logout
- GIVEN an active session
- WHEN logout is called with its refresh token
- THEN refresh with that family fails afterward

#### Scenario: Access token after logout
- GIVEN an access token issued before logout and not yet expired
- WHEN a consumer validates it locally
- THEN it remains valid until `exp` (accepted limitation)

### Requirement: Key management

Private signing keys MUST be loaded from a secrets store or environment and MUST NOT be committed or logged. The service MUST support rotating the active `kid`.

#### Scenario: Compromised key
- GIVEN a key is compromised
- WHEN operators rotate the `kid` and revoke all refresh tokens
- THEN new tokens use the new key
- AND the compromised key is removed from JWKS
