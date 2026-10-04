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
- AND the existing owner receives an "account exists / signup attempt" notice email that suggests logging in or resetting the password, with links built from `AUTH_PUBLIC_BASE_URL`

### Requirement: Account routes

The system MUST expose `POST /accounts/signup`, `GET /accounts/confirm` (token in the `token` query parameter), `POST /accounts/resend-confirmation`, and `GET /me`.

#### Scenario: Route surface
- GIVEN the Phase 1 release
- WHEN the account routes are listed
- THEN exactly these four routes exist for account management

### Requirement: Registration

`POST /accounts/signup` MUST accept registration with `client_id`, email, and password. Passwords MUST be hashed with bcrypt at cost 12 or higher. New accounts MUST start unconfirmed and a confirmation email MUST be sent. (Assumption: minimum password length is 8; richer policies are Phase 3.)

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

### Requirement: Email confirmation

The system MUST confirm an account via a single-use link token valid for 24 hours. Tokens MUST be generated with a cryptographically secure RNG (at least 32 bytes) and stored only as a hash. Resending MUST be supported and MUST invalidate previous unused confirmation tokens.

#### Scenario: Valid confirmation
- GIVEN an unconfirmed account and an unexpired, unused token
- WHEN the user opens the link
- THEN the account becomes confirmed
- AND the token is marked used
- AND a welcome email is sent

#### Scenario: Expired, used, or unknown token
- GIVEN a token older than 24h, already used, or never issued
- WHEN the link is opened
- THEN the service returns a generic invalid-or-expired-link error
- AND the account state is unchanged

#### Scenario: Resend confirmation
- GIVEN an unconfirmed account with an outstanding token
- WHEN a resend is requested for that email and app
- THEN a new token is issued and the old one is invalidated
- AND the response is identical whether or not the account exists or is already confirmed

### Requirement: Unconfirmed users cannot log in

The system MUST NOT issue an authorization code or tokens for an unconfirmed account.

#### Scenario: Login before confirmation
- GIVEN an unconfirmed account with the correct password
- WHEN the user attempts to log in
- THEN no code or tokens are issued
- AND the response is the same generic invalid-credentials error as a wrong password

(Assumption: the user is not told "unconfirmed" in the login response, to avoid enumeration; the hosted UI MAY offer a generic "resend confirmation" link.)

### Requirement: Profile retrieval

The system MUST expose `GET /me` authenticated by a valid access token and return the profile (`sub`, email, confirmation state) for the token's account only. The token's `aud` MUST match the app.

#### Scenario: Valid token
- GIVEN a valid, unexpired access token
- WHEN the client calls `GET /me`
- THEN the profile of `sub` is returned
- AND no password hash or internal fields are returned

#### Scenario: Missing or invalid token
- GIVEN no token, an expired token, or a bad signature
- WHEN `GET /me` is called
- THEN the service returns 401 with a generic error

### Requirement: Generic error messages

All authentication-related errors (login, signup, confirmation, resend, reset) MUST use generic messages and equivalent status codes and SHOULD have comparable response times, so existence of an account cannot be inferred.

#### Scenario: Unknown email vs wrong password
- GIVEN one login with an unregistered email and one with a registered email and wrong password
- WHEN both are submitted
- THEN both return the same status code and the same message body
