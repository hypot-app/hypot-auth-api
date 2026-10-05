# Session Auth Specification

## Purpose

JSON login, refresh and logout for first-party app frontends. A refresh-token family is a session. This capability replaces `authorization-flow`, which is REMOVED (authorization code, PKCE and hosted login are out of scope; see Phase 4). Access-token format and JWKS stay in `token-lifecycle`. Limits and lockout live in `abuse-protection`.

## Requirements

### Requirement: Login

The system MUST expose `POST /api/v1/auth/login` accepting JSON `{client_id, email, password}`. On success it MUST return 200 with JSON `{access_token, token_type: "Bearer", expires_in, refresh_token}`. `expires_in` MUST be 3600. No cookie MUST be set. The email MUST be normalized to lowercase. The account is looked up within the app of `client_id` only.

#### Scenario: Successful login
- GIVEN a confirmed account in app A and the correct password
- WHEN the frontend posts `{client_id: A, email, password}`
- THEN the response is 200 with `access_token`, `token_type` `Bearer`, `expires_in` 3600 and `refresh_token`
- AND the access token has `aud` equal to A's `client_id`
- AND no `Set-Cookie` header is present

#### Scenario: Same email in another app
- GIVEN the email exists only in app B
- WHEN login is attempted for app A
- THEN the generic login failure is returned

### Requirement: Generic login failure

Login MUST return one identical failure (same status 401, body and headers) for: unknown email, wrong password, unconfirmed account, locked account, blocked (account, IP) pair, rate-limited IP, and unknown or inactive `client_id`. Every attempt that `abuse-protection` lets through MUST perform exactly one bcrypt comparison (against a dummy hash when no usable account exists, including an unknown `client_id`) with no early return, so response time does not reveal the cause. An attempt rejected by a rate limit or block is answered before bcrypt runs, which protects the CPU; unknown emails are limited and blocked the same way, so this reveals nothing about accounts. The correct password on an unconfirmed, locked or blocked account MUST NOT issue tokens.

#### Scenario: Indistinguishable failures
- GIVEN an unknown email, a wrong password, an unconfirmed account with the right password, and a locked account with the right password
- WHEN each logs in
- THEN status, body and headers are identical in all four cases

#### Scenario: Equal cost
- GIVEN an unknown email and a known email with a wrong password
- WHEN both log in
- THEN each runs exactly one bcrypt comparison at cost 12

#### Scenario: Malformed body
- GIVEN a body missing `email` or `password`, or with non-string values
- WHEN login is posted
- THEN the response is a 400 validation error that does not mention account state

### Requirement: Refresh with rotation

The system MUST expose `POST /api/v1/auth/refresh` accepting JSON `{client_id, refresh_token}`. A valid token MUST return 200 with the same body shape as login (new access token and new refresh token in the same family) and MUST mark the presented token used. Refresh tokens MUST be opaque, at least 32 random bytes, stored only as a hash, bound to account, app and family. The absolute session lifetime MUST be 30 days from login (assumption, kept from earlier rounds); rotation MUST NOT extend it. Each refresh token MUST also expire after 7 days without use (assumption, configurable), capped at the session expiry.

#### Scenario: Normal rotation
- GIVEN a valid refresh token R1 of app A
- WHEN it is posted with `client_id` A
- THEN a new access token and refresh token R2 are returned
- AND R1 is marked used

#### Scenario: Wrong app, unknown or expired token
- GIVEN a token of app A presented with `client_id` B, an unknown token, or a token past 30 days
- WHEN refresh is posted
- THEN the response is 401 with the generic `invalid_grant` error, identical in all three cases

#### Scenario: Database exposure
- GIVEN read access to the refresh token table
- WHEN rows are inspected
- THEN no usable refresh token value is present

### Requirement: Reuse detection

Presenting a used or revoked refresh token MUST revoke the whole family and fail with the generic `invalid_grant` error. Concurrent use of the same token is treated as reuse (assumption: no grace window).

#### Scenario: Replay of a rotated token
- GIVEN R1 was rotated into R2 and R2 into R3
- WHEN R1 is presented
- THEN the request fails with `invalid_grant`
- AND R2 and R3 are revoked, so the user must log in again

### Requirement: Logout

The system MUST expose `POST /api/v1/auth/logout` accepting JSON `{client_id, refresh_token}`. It MUST revoke the token's family and MUST be idempotent: it returns 204 for an active, already-revoked, expired, unknown or other-app token alike, and revokes nothing for a token that does not belong to `client_id`.

#### Scenario: Logout
- GIVEN an active session
- WHEN logout is posted with its refresh token
- THEN the response is 204
- AND a later refresh with that family fails

#### Scenario: Repeated or bogus logout
- GIVEN an already-revoked token, or a random string
- WHEN logout is posted
- THEN the response is 204 with no state change

#### Scenario: Access token after logout
- GIVEN an access token issued before logout and not yet expired
- WHEN a consumer validates it locally
- THEN it stays valid until `exp` (accepted limitation, no denylist)

### Requirement: Session revocation on credential change

A password reset or password change MUST revoke all refresh families of that account (see `password-management`). A key compromise procedure MUST allow revoking all refresh families of all apps.

#### Scenario: Reset ends sessions
- GIVEN an account with two active sessions
- WHEN its password is reset
- THEN both refresh tokens fail afterward
