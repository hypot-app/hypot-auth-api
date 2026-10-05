# User Accounts Specification

## Purpose

Per-app user registration, email confirmation, and profile retrieval. Auth owns credentials; consuming apps never store passwords.

## Requirements

### Requirement: Per-app account uniqueness

The system MUST enforce uniqueness on the pair `(app_id, email)`. Email comparison MUST be case-insensitive (emails normalized to lowercase). The same email MAY exist in different apps as independent accounts with independent passwords.

#### Scenario: Same email in two apps
- GIVEN `user@x.com` is registered in app A
- WHEN `user@x.com` registers in app B with a different password
- THEN a second, independent account is created
- AND the app A password does not authenticate against app B

#### Scenario: Duplicate within one app
- GIVEN `user@x.com` exists in app A
- WHEN someone registers `User@X.com` in app A
- THEN no second account is created
- AND the response is identical to a successful signup (no enumeration)
- AND the existing owner receives an "account exists / signup attempt" notice email that suggests logging in or resetting the password, with the app's `password_reset_url` (no token)

### Requirement: Account routes and CORS

The system MUST expose `POST /api/v1/accounts/signup`, `POST /api/v1/accounts/confirm` (JSON `{token}`), `POST /api/v1/accounts/resend-confirmation` (JSON `{client_id, email}`), and `GET /api/v1/me`. There MUST be no `GET /api/v1/accounts/confirm`: a GET MUST NOT consume a token, so mail scanners and link prefetchers cannot confirm accounts. These routes are called by app frontends from the browser, so they MUST apply the origin-bound CORS rules of `app-registry`. The earlier "no CORS on accounts" rule is removed. For `confirm`, the app is the one the token belongs to.

#### Scenario: Route surface
- GIVEN the Phase 1 release
- WHEN the account routes are listed
- THEN exactly these four routes exist for account management

#### Scenario: GET does not confirm
- GIVEN an unused confirmation token
- WHEN `GET /api/v1/accounts/confirm?token=...` is requested
- THEN the service responds 404
- AND the token stays unused

#### Scenario: Signup from the app origin
- GIVEN app A allows `https://a.example`
- WHEN its frontend posts signup with `client_id` A
- THEN the response allows that origin
- AND a post from another app's origin is rejected

### Requirement: Registration

`POST /api/v1/accounts/signup` MUST accept registration with `client_id`, email, and password. Passwords MUST be hashed with bcrypt at cost 12 or higher. New accounts MUST start unconfirmed and a confirmation email MUST be sent. (Assumption: minimum password length is 8; richer policies are Phase 3.)

#### Scenario: Successful signup
- GIVEN a valid `client_id`, a well-formed email, and a password of at least 8 characters
- WHEN the user registers
- THEN an unconfirmed account is created with a bcrypt hash (cost >= 12)
- AND a confirmation email is queued
- AND no tokens are issued

#### Scenario: Invalid input
- GIVEN a malformed email or a too-short password
- WHEN the user registers
- THEN the service returns a validation error that does not reveal account existence

#### Scenario: Password longer than 72 bytes
- GIVEN a password whose UTF-8 encoding is longer than 72 bytes (bcrypt ignores everything past byte 72)
- WHEN the user registers
- THEN the service returns a validation error stating the 72-byte maximum
- AND no account is created
- AND the length is counted in bytes, so 36 two-byte characters pass and 37 do not

#### Scenario: Password with a NUL character
- GIVEN a password containing a NUL character (bcrypt stops reading at one)
- WHEN the user registers
- THEN the service returns a validation error and no account is created

### Requirement: Email confirmation

The system MUST confirm an account via a single-use link token valid for 24 hours. Tokens MUST be generated with a cryptographically secure RNG (at least 32 bytes) and stored only as a hash. Resending MUST be supported and MUST invalidate previous unused confirmation tokens.

#### Scenario: Valid confirmation
- GIVEN an unconfirmed account and an unexpired, unused token
- WHEN the app frontend posts the token from the link fragment to `POST /api/v1/accounts/confirm`
- THEN the account becomes confirmed
- AND the token is marked used
- AND a welcome email is sent

#### Scenario: Expired, used, or unknown token
- GIVEN a token older than 24h, already used, or never issued
- WHEN it is posted to confirm
- THEN the service returns a generic invalid-or-expired error
- AND the account state is unchanged

#### Scenario: Resend confirmation
- GIVEN an unconfirmed account with an outstanding token
- WHEN a resend is requested for that email and app
- THEN a new token is issued and the old one is invalidated
- AND the response is identical whether or not the account exists or is already confirmed

### Requirement: Unconfirmed users cannot log in

The system MUST NOT issue tokens for an unconfirmed account (see `session-auth`).

#### Scenario: Login before confirmation
- GIVEN an unconfirmed account with the correct password
- WHEN the user attempts to log in
- THEN no tokens are issued
- AND the response is the same generic login failure as a wrong password

(Assumption: the user is never told "unconfirmed" in the login response, to avoid enumeration; app UIs MAY offer a generic "resend confirmation" action.)

### Requirement: Profile retrieval

The system MUST expose `GET /api/v1/me` authenticated by a Bearer access token. The token MUST be verified (RS256, `typ: at+jwt`, issuer, expiry), and its `aud` MUST be REQUIRED and equal to the `client_id` of an ACTIVE app; a token with a missing, unknown or inactive audience MUST be rejected. The response is the profile (`sub`, email, confirmation state) of the token's account only.

#### Scenario: Valid token
- GIVEN a valid, unexpired access token whose `aud` is an active app
- WHEN the client calls `GET /api/v1/me`
- THEN the profile of `sub` is returned
- AND no password hash or internal fields are returned

#### Scenario: Missing or invalid token
- GIVEN no token, an expired token, or a bad signature
- WHEN `GET /api/v1/me` is called
- THEN the service returns 401 with a generic error

#### Scenario: Audience missing or inactive
- GIVEN a validly signed token with no `aud`, an unknown `aud`, or the `aud` of a deactivated app
- WHEN `GET /api/v1/me` is called
- THEN the service returns 401 with the same generic error

### Requirement: Generic error messages

All authentication-related errors (login, refresh, signup, confirmation, resend, forgot, reset) MUST use generic messages and equivalent status codes and SHOULD have comparable response times, so existence of an account cannot be inferred.

#### Scenario: Unknown email vs wrong password
- GIVEN one login with an unregistered email and one with a registered email and wrong password
- WHEN both are submitted
- THEN both return the same status code and the same message body
