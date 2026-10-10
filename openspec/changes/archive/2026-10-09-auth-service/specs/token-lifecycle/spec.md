# Token Lifecycle Specification

## Purpose

Keys, JWKS publication, and RS256 access-token issue and verification. Refresh tokens, rotation, reuse detection and logout moved to `session-auth`. The OAuth token and revoke endpoints are REMOVED (no code exchange, no `grant_type`).

## Requirements

### Requirement: Access token format

Access tokens MUST be RS256-signed JWTs with a 1-hour lifetime. Claims MUST include `iss` (the Auth issuer URL), `aud` (the app's `client_id`), `sub` (the account id), `iat`, `exp`, and `jti`. The JWT header MUST include `kid` and `typ: at+jwt`. Tokens MUST NOT carry roles or permissions. Verifiers MUST require RS256 and `typ: at+jwt`. The issuer string MUST be exactly the configured `AUTH_PUBLIC_BASE_URL` (an absolute `https` URL with no trailing slash, no query and no fragment in production), and the JWKS URL MUST be `${iss}/.well-known/jwks.json`. Auth does not normalize the value at runtime: what the operator configures is what appears in `iss`.

#### Scenario: Issuer and JWKS URL
- GIVEN `AUTH_PUBLIC_BASE_URL` is `https://auth.example`
- WHEN a token is issued
- THEN `iss` is exactly `https://auth.example`
- AND the JWKS is served at `https://auth.example/.well-known/jwks.json`

#### Scenario: Token claims
- GIVEN a successful login for app A
- WHEN the access token is decoded
- THEN `aud` equals app A's `client_id`
- AND `iss` equals the configured issuer
- AND the header has `typ` `at+jwt` and a `kid` published in JWKS
- AND `exp - iat` equals 3600 seconds
- AND no `roles` claim is present

#### Scenario: Audience mismatch at the consumer
- GIVEN a token issued for app A
- WHEN app B validates it against JWKS
- THEN app B rejects it because `aud` differs from its own `client_id`

### Requirement: JWKS endpoint

The system MUST publish public keys at `/.well-known/jwks.json` so apps validate tokens locally. During key rotation, it MUST publish both the current and previous keys until all tokens signed by the previous key have expired.

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

### Requirement: No OAuth token endpoints

The system MUST NOT expose `/api/v1/oauth/token`, `/api/v1/oauth/revoke`, or `/api/v1/oauth/authorize`.

#### Scenario: Endpoints absent
- GIVEN the running service
- WHEN any `/api/v1/oauth/*` route is requested
- THEN the service responds 404

### Requirement: Key management

Private signing keys MUST be loaded from a secrets store or environment and MUST NOT be committed or logged. The service MUST support rotating the active `kid`.

#### Scenario: Compromised key
- GIVEN a key is compromised
- WHEN operators rotate the `kid` and revoke all refresh families
- THEN new tokens use the new key
- AND the compromised key is removed from JWKS
