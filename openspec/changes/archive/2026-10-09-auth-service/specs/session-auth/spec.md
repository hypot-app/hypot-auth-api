# Session Auth Specification

## Purpose

JSON login, refresh and logout for first-party app frontends. A refresh-token family is a session. This capability replaces `authorization-flow`, which is REMOVED (authorization code, PKCE and hosted login are out of scope; see Phase 4). Access-token format and JWKS stay in `token-lifecycle`. Limits and lockout live in `abuse-protection`.

## Requirements

### Requirement: Login

The system MUST expose `POST /api/v1/auth/login` accepting JSON `{client_id, email, password}`. On success it MUST return 200 with JSON `{access_token, token_type: "Bearer", expires_in, refresh_token}`. `expires_in` MUST be 3600. No cookie MUST be set. Every answer of every `/api/v1/auth/*` route (success and error) MUST carry `Cache-Control: no-store` and `Pragma: no-cache` (RFC 6749 section 5.1 for the token responses; the errors share the rule so that all answers of a route stay alike). The email MUST be normalized to lowercase. The account is looked up within the app of `client_id` only.

#### Scenario: Successful login
- GIVEN a confirmed account in app A and the correct password
- WHEN the frontend posts `{client_id: A, email, password}`
- THEN the response is 200 with `access_token`, `token_type` `Bearer`, `expires_in` 3600 and `refresh_token`
- AND the access token has `aud` equal to A's `client_id`
- AND no `Set-Cookie` header is present
- AND the response carries `Cache-Control: no-store` and `Pragma: no-cache`

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
- THEN the response is `400 invalid_request` that does not mention account state

### Requirement: Refresh with rotation

The system MUST expose `POST /api/v1/auth/refresh` accepting JSON `{client_id, refresh_token}`. A valid token MUST return 200 with the same body shape as login (new access token and new refresh token in the same family) and MUST mark the presented token used. Refresh tokens MUST be opaque, at least 32 random bytes, stored only as a hash, bound to account, app and family. The absolute session lifetime MUST be 30 days from login (assumption, kept from earlier rounds); rotation MUST NOT extend it. Each refresh token MUST also expire after 7 days without use (assumption, configurable), capped at the session expiry. A malformed body (missing or non-string field) MUST return `400 invalid_request`. A request with an `Origin` header that is not bound to the app of `client_id` MUST get the same `401 invalid_grant` as an invalid token, with no CORS allow header, so a response never reveals whether a token is valid. Refresh MUST be limited per client IP (see `abuse-protection`); a limited request returns `429` with `Retry-After`, not `invalid_grant`.

#### Scenario: Normal rotation
- GIVEN a valid refresh token R1 of app A
- WHEN it is posted with `client_id` A
- THEN a new access token and refresh token R2 are returned
- AND R1 is marked used

#### Scenario: Wrong app, unknown or expired token
- GIVEN a token of app A presented with `client_id` B, an unknown token, or a token past 30 days
- WHEN refresh is posted
- THEN the response is 401 with the generic `invalid_grant` error, identical in all three cases

#### Scenario: Origin not bound to the client
- GIVEN a valid refresh token of app A and a browser at app B's origin
- WHEN it posts refresh with `client_id` A
- THEN the response is the same `401 invalid_grant` as for an unknown token
- AND no `Access-Control-Allow-Origin` header is returned
- AND the token is not consumed

#### Scenario: Database exposure
- GIVEN read access to the refresh token table
- WHEN rows are inspected
- THEN no usable refresh token value is present

### Requirement: Reuse detection

Presenting a used or revoked refresh token MUST revoke the whole family and fail with the generic `invalid_grant` error, except inside the reuse grace window defined below.

**Reuse grace window (round 11).** The window MUST be configurable (`REFRESH_REUSE_GRACE_SECONDS`, default 10, `0` disables it) and is measured from the moment the token was rotated. A rotated token presented again MUST NOT revoke the session when ALL of these hold: (1) the request is inside the window; (2) its client IP equals the client IP of the rotation (the normalized `ClientIp` of `abuse-protection`, IPv6 compared on its /64); (3) the grace has not been used before for that rotated token; (4) the successor issued by that rotation is still unused. In that case the system MUST revoke that successor, issue a fresh access token and a fresh refresh token in the SAME session, and respond 200 with the login body shape. The grace MUST apply at most once per rotated token. The system MUST NOT store a raw successor token or ever return the same successor again: a new token is minted instead. In every other case (after the window, from another IP, a second reuse of the same token, the successor already used or revoked, a revoked session) the whole family MUST be revoked as before. Concurrent presentations of one token are not special: one wins the rotation, and the others are treated as presentations of a rotated token under the rules above.

#### Scenario: Reuse inside the window from the same IP
- GIVEN R1 was rotated into R2 from IP X a few seconds ago and R2 has not been used
- WHEN R1 is presented again from IP X inside the window
- THEN the response is 200 with a new access token and a new refresh token R3 in the same session
- AND R2 is revoked
- AND the session is not revoked
- AND R3 is not R2

#### Scenario: Reuse inside the window from a different IP
- GIVEN R1 was rotated into R2 from IP X a few seconds ago
- WHEN R1 is presented from IP Y inside the window
- THEN the request fails with `invalid_grant`
- AND the whole session is revoked

#### Scenario: Reuse after the window
- GIVEN R1 was rotated into R2 from IP X more than the grace window ago
- WHEN R1 is presented from IP X
- THEN the request fails with `invalid_grant`
- AND the whole session is revoked

#### Scenario: Second reuse of the same token
- GIVEN R1 was rotated into R2, and a first reuse of R1 inside the window already produced R3
- WHEN R1 is presented a second time, even inside the window from the same IP
- THEN the request fails with `invalid_grant`
- AND the whole session is revoked

#### Scenario: Successor already used
- GIVEN R1 was rotated into R2 and R2 was then rotated into R3
- WHEN R1 is presented inside the window from the same IP
- THEN the request fails with `invalid_grant`
- AND the whole session is revoked

#### Scenario: Grace disabled
- GIVEN `REFRESH_REUSE_GRACE_SECONDS` is `0`
- WHEN a rotated token is presented again from the same IP right after its rotation
- THEN the whole session is revoked

#### Scenario: Revoked successor is not a free pass
- GIVEN a grace reuse revoked R2 and issued R3
- WHEN R2 is later presented
- THEN the request fails with `invalid_grant`
- AND the whole session is revoked

#### Scenario: Database exposure after a grace reuse
- GIVEN read access to the refresh token table after a grace reuse
- WHEN rows are inspected
- THEN only hashes are present, and no raw token can be recovered for R2 or R3

#### Scenario: Replay of a rotated token
- GIVEN R1 was rotated into R2 and R2 into R3, and the grace window for R1 has passed
- WHEN R1 is presented
- THEN the request fails with `invalid_grant`
- AND R2 and R3 are revoked, so the user must log in again

### Requirement: Logout

The system MUST expose `POST /api/v1/auth/logout` accepting JSON `{client_id, refresh_token}`. It MUST revoke the token's family and MUST be idempotent: it returns 204 for an active, already-revoked, expired, unknown or other-app token alike, and revokes nothing for a token that does not belong to `client_id`. When the request has an `Origin` header that is not bound to the app of `client_id`, it MUST still return 204 but MUST have no effect (no revocation) and MUST NOT send a CORS allow header. A malformed body (missing or non-string field) MUST return `400 invalid_request`.

#### Scenario: Logout
- GIVEN an active session
- WHEN logout is posted with its refresh token
- THEN the response is 204
- AND a later refresh with that family fails

#### Scenario: Repeated or bogus logout
- GIVEN an already-revoked token, or a random string
- WHEN logout is posted
- THEN the response is 204 with no state change

#### Scenario: Logout from an unbound origin
- GIVEN an active session of app A and a browser at app B's origin
- WHEN logout is posted with `client_id` A and that session's refresh token
- THEN the response is 204
- AND the session is still active
- AND no `Access-Control-Allow-Origin` header is returned

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
