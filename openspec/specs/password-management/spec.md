# Password Management Specification

## Purpose

Forgot, reset and change password as JSON endpoints. Auth serves no pages: each app renders its own forms and calls these endpoints.

## Requirements

### Requirement: Password routes

The system MUST expose exactly `POST /api/v1/password/forgot`, `POST /api/v1/password/reset` and `POST /api/v1/password/change`, all JSON. There MUST be no `GET` route under `/api/v1/password`, no hosted page, and no redirect.

#### Scenario: No hosted pages
- GIVEN the running service
- WHEN `GET /api/v1/password/forgot` or `GET /api/v1/password/reset` is requested
- THEN the service responds 404

### Requirement: Forgot password

`POST /api/v1/password/forgot` MUST accept `{client_id, email}` and ALWAYS respond 202 with the same fixed generic body `{ "message": "If an account exists for this address, an email is on its way." }`, regardless of whether the account exists, is unconfirmed, or exists only in another app. For a confirmed account in that app the system MUST send a reset email, with a link built from the app's `password_reset_url` (see `transactional-email`). For an UNCONFIRMED account in that app it MUST NOT send a reset email: it MUST send a confirmation email instead (a new confirmation token that supersedes earlier unused ones, as in resend-confirmation), because a reset could not be used to log in. For an unknown email, or one that exists only in another app, nothing is sent. Every email sent counts toward the per-account email cap of `abuse-protection`. A malformed body returns `400 invalid_request`, and a string that is not a valid email address returns `400 invalid_email`: that check depends only on the submitted input, never on stored state, so it is not an existence oracle (this is the one exception to ALWAYS 202). Rate limits follow `abuse-protection`.

#### Scenario: Existing account
- GIVEN a confirmed account in app A
- WHEN forgot-password is requested for its email
- THEN a reset email with a single-use token is sent
- AND the response is the generic 202

#### Scenario: Unknown email or other app
- GIVEN no account for the email in app A (or it exists only in app B)
- WHEN forgot-password is requested
- THEN no email is sent
- AND status and body are identical to the existing-account case

#### Scenario: Unconfirmed account gets a confirmation email
- GIVEN an unconfirmed account in app A
- WHEN forgot-password is requested for its email
- THEN a confirmation email with a new token is sent (no reset email, no reset token)
- AND the earlier unused confirmation token is invalidated
- AND status and body are identical to the existing-account case
- AND the email counts toward the per-account cap

#### Scenario: Capped unconfirmed account
- GIVEN 3 emails were already sent for the unconfirmed account in the last hour
- WHEN forgot-password is requested again
- THEN the generic 202 is returned
- AND nothing is sent

#### Scenario: Unknown client_id
- GIVEN an unknown or inactive `client_id`
- WHEN forgot-password is requested
- THEN the generic invalid-client error is returned and no email is sent

### Requirement: Reset password

`POST /api/v1/password/reset` MUST accept `{token, new_password}`; the token alone identifies the account and app. On success the system MUST replace the password hash (bcrypt cost 12 or higher), mark the token used, revoke ALL refresh families of that account, and respond 204 with no redirect. Reset tokens MUST come from a secure RNG (at least 32 bytes), be stored only as a hash, be valid for 1 hour, and be single-use. A new forgot request MUST invalidate earlier unused reset tokens for that account. Any invalid, expired, used or superseded token MUST fail with one generic invalid-or-expired error.

#### Scenario: Valid reset
- GIVEN an unexpired, unused token and an account with two active sessions
- WHEN a valid new password is submitted with it
- THEN the hash is replaced and the token is marked used
- AND both refresh tokens are revoked

#### Scenario: Token reuse, expiry or supersession
- GIVEN a used token, a token older than 1 hour, or the first of two issued tokens
- WHEN it is submitted
- THEN the generic invalid-or-expired error is returned
- AND the password is unchanged

#### Scenario: Weak password keeps the token
- GIVEN a valid token and a password shorter than 8 characters
- WHEN it is submitted
- THEN a validation error is returned and the token stays usable

### Requirement: Change password

`POST /api/v1/password/change` MUST require a valid Bearer access token (audience validated against an active app) and accept `{current_password, new_password}`. On success it MUST replace the hash, revoke ALL refresh families of the account including the caller's own (the client logs in again with the new password; the current access token stays valid until `exp`), send a password-changed notice (assumption), and respond 204. A wrong current password MUST fail with `400 { "error": "invalid_current_password", "message": ... }` and count as a failed login for both lockout counters of `abuse-protection`. It MUST NOT be a `401`, so a client can tell it apart from an expired access token and never refreshes in a loop. While the (account, IP) pair is blocked or the account is locked, change MUST return the same `400 invalid_current_password` even for the correct current password, without running bcrypt. Order of checks: Bearer authentication (`401` on failure), body shape (`400 invalid_request`), new-password rules (`400 invalid_password`, no counter touched), lockout state, current-password comparison. A success resets the pair counter only, as in login. The hash update MUST be conditional on the hash that was verified (compare-and-swap): if a reset or another change committed while the request was hashing, the request MUST write, revoke and queue nothing and answer `400 invalid_current_password`; this is not a wrong guess, so the pair counter is refunded as on a success (the account counter keeps the attempt).

#### Scenario: Successful change
- GIVEN a valid access token and the correct current password
- WHEN a valid new password is submitted
- THEN the hash is replaced and all refresh families are revoked

#### Scenario: Wrong current password
- GIVEN a valid access token
- WHEN the current password is wrong
- THEN the response is `400` with `error` `invalid_current_password`
- AND the password is unchanged and no session is revoked
- AND the attempt was counted on both lockout counters before the password was checked

#### Scenario: Wrong current password is not a 401
- GIVEN a valid access token and a wrong current password
- WHEN change is requested
- THEN the status is 400, never 401

#### Scenario: Change while blocked
- GIVEN the (account, IP) pair is blocked after 5 failures
- WHEN change is requested with the CORRECT current password from that IP
- THEN the response is `400 invalid_current_password`
- AND the password is unchanged and no bcrypt comparison ran

#### Scenario: Missing token
- GIVEN no Bearer token or an invalid one
- WHEN change is requested
- THEN the response is 401 with a generic error

### Requirement: Password handling

Passwords MUST NOT be logged, returned, or stored in plaintext. New passwords MUST meet the signup rules (8 characters minimum, 72 bytes maximum, no NUL).

#### Scenario: Weak new password
- GIVEN a new password shorter than 8 characters
- WHEN reset or change is submitted
- THEN it is rejected with a validation error and no state changes
