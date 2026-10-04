# Authorization Flow Specification

## Purpose

Hosted login and OAuth2 Authorization Code with PKCE, so app backends and clients never handle passwords.

## Requirements

### Requirement: Authorization endpoint

The system MUST provide an authorization endpoint at `GET /api/v1/oauth/authorize` that accepts `client_id`, `redirect_uri`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`, and `state`, and presents a hosted login (and signup) page. The hosted UI is minimal and unbranded in Phase 1.

#### Scenario: Valid authorization request
- GIVEN a registered app and an exactly matching `redirect_uri`
- WHEN the browser requests the authorization endpoint with a valid S256 challenge
- THEN the hosted login page is rendered

#### Scenario: Invalid client or redirect URI
- GIVEN an unknown `client_id` or an unregistered `redirect_uri`
- WHEN the endpoint is requested
- THEN an error page is shown on the Auth domain
- AND no redirect to the supplied URI occurs

### Requirement: PKCE always required

PKCE MUST be required for every client, public and confidential. Requests without `code_challenge`, or with `code_challenge_method` other than `S256`, MUST be rejected. The `plain` method MUST NOT be supported.

#### Scenario: Missing code_challenge
- GIVEN a confidential app
- WHEN the authorization request omits `code_challenge`
- THEN the request is rejected with an invalid-request error redirected to the registered URI with `state`

#### Scenario: Plain method
- GIVEN `code_challenge_method=plain`
- WHEN the request is made
- THEN it is rejected

### Requirement: Credential submission and code issuance

The hosted login form MUST submit to `POST /api/v1/oauth/login`. On valid credentials for a confirmed account of that app, the system MUST issue a single-use authorization code bound to `client_id`, `redirect_uri`, `code_challenge`, and the account, and redirect to `redirect_uri` with `code` and the original `state`. Codes MUST be stored hashed and expire in at most 60 seconds (assumption: 60s).

#### Scenario: Successful login
- GIVEN a confirmed account with the correct password
- WHEN credentials are submitted on the hosted page
- THEN the browser is redirected to `redirect_uri?code=...&state=...`

#### Scenario: Failed login
- GIVEN wrong password, unknown email, or unconfirmed account
- WHEN credentials are submitted
- THEN the same generic invalid-credentials message is shown in all three cases
- AND no code is issued

### Requirement: Code exchange

The token endpoint (`POST /api/v1/oauth/token`, `grant_type=authorization_code`) MUST exchange a code only when `client_id`, `redirect_uri`, and `code_verifier` (SHA-256 matching the stored challenge) are all valid. Confidential clients MUST additionally authenticate with their client secret. A code MUST be usable once; reuse MUST fail.

#### Scenario: Valid exchange
- GIVEN an unexpired unused code and the matching verifier
- WHEN the client posts to the token endpoint
- THEN an access token and a refresh token are returned

#### Scenario: Wrong verifier
- GIVEN a valid code
- WHEN the exchange sends a non-matching `code_verifier`
- THEN the exchange fails with a generic invalid-grant error
- AND the code is invalidated

#### Scenario: Code reuse
- GIVEN a code already exchanged
- WHEN it is presented again
- THEN the exchange fails with invalid-grant

#### Scenario: Code from another app
- GIVEN a code issued to app A
- WHEN app B presents it
- THEN the exchange fails with invalid-grant

### Requirement: Client types

The system MUST support public clients (SPA, mobile; PKCE only, no secret) and confidential clients (PKCE plus client secret).

#### Scenario: Confidential client without secret
- GIVEN a confidential app
- WHEN it exchanges a code without a valid client secret
- THEN the exchange is rejected
