# Password Management Specification

## Purpose

Change password, forgot password, and reset password flows.

## Requirements

### Requirement: Password routes

The system MUST expose `GET /api/v1/password/forgot` (hosted forgot-password form, `client_id` query parameter), `POST /api/v1/password/forgot`, `GET /api/v1/password/reset` (hosted reset form, token in the `token` query parameter), `POST /api/v1/password/reset`, and `POST /api/v1/password/change`. The reset link in emails MUST point to `GET /api/v1/password/reset`.

#### Scenario: Reset form
- GIVEN a reset link from an email
- WHEN the user opens `GET /api/v1/password/reset?token=...`
- THEN the hosted reset form is rendered without revealing whether the token is valid

### Requirement: Hosted forgot-password page

`GET /api/v1/password/forgot?client_id=...` MUST render a server-side form (strict CSP, CSRF protection, same approach as the hosted login and reset form) that posts `(client_id, email)` to `POST /api/v1/password/forgot`. The `client_id` MUST be validated against the app registry; an unknown or inactive `client_id` MUST render the same generic error page as `/api/v1/oauth/authorize`, with no form. The hosted login page MUST link to this page with its `client_id`. The reset email link MUST carry the `client_id`, and the reset MUST fail with the generic invalid-or-expired error when it does not match the token's app. The page and its submit response MUST NOT reveal whether an account exists.

#### Scenario: Form rendered for a valid app
- GIVEN an active app A
- WHEN the user opens `GET /api/v1/password/forgot?client_id=<A>`
- THEN the form is rendered with `client_id` and a CSRF token
- AND the response carries the strict CSP header

#### Scenario: Unknown or inactive client
- GIVEN a `client_id` that is unknown or inactive
- WHEN the page is requested
- THEN the generic error page is rendered and no form is shown

#### Scenario: Generic submit response
- GIVEN the form is submitted for a confirmed account, an unknown email, or an email that exists only in another app
- WHEN the response is compared
- THEN status and body are identical in all three cases

#### Scenario: Missing or invalid CSRF token
- GIVEN a form submit without a valid CSRF token
- WHEN it is posted
- THEN it is rejected and no email is sent

#### Scenario: Login page link
- GIVEN the hosted login page for app A
- WHEN it is rendered
- THEN it contains a link to `/api/v1/password/forgot?client_id=<A>`

#### Scenario: App-scoped reset
- GIVEN a reset email sent for app A
- WHEN its link is opened and the password is reset
- THEN the link carries app A's `client_id` and the success page is rendered for app A
- AND a link whose `client_id` does not match the token's app fails with the generic error

### Requirement: Post-reset redirect

After a successful password reset, the system MUST redirect the user (HTTP 302) to the app's stored `post_reset_redirect_uri` when it is set. When it is null, the system MUST render the existing app-scoped confirmation page and MUST NOT redirect. The redirect target MUST come only from the app record. The system MUST NOT accept a redirect URL from any query parameter, form field, or header (no open redirect). The redirect URL MUST NOT carry tokens, the `client_id`-bound reset token, the email, or any other PII. A failed reset (invalid, expired, used, superseded, mismatched `client_id`, or weak password) MUST NOT redirect.

#### Scenario: Redirect when the app has a URL
- GIVEN app A has `post_reset_redirect_uri=https://a.example/login`
- WHEN a valid reset is submitted for app A
- THEN the password is replaced and the response is a 302 to exactly `https://a.example/login`
- AND the URL has no query string added by Auth

#### Scenario: Confirmation page when the URL is null
- GIVEN app A has a null `post_reset_redirect_uri`
- WHEN a valid reset is submitted for app A
- THEN the response is the app-scoped confirmation page (200) and there is no redirect

#### Scenario: Redirect input is ignored
- GIVEN a reset submit that includes `redirect_uri`, `next`, or `return_to` in the query or the form body
- WHEN the reset succeeds
- THEN the supplied value is ignored
- AND the user is sent only to the app's stored URL, or sees the confirmation page when it is null

#### Scenario: No redirect on failure
- GIVEN an invalid, expired, reused, or superseded token, a `client_id` mismatch, or a weak password
- WHEN the reset is submitted
- THEN the generic error or validation response is returned with no redirect

### Requirement: Forgot password

`POST /api/v1/password/forgot` MUST accept a forgot-password request for `(client_id, email)` and ALWAYS respond with the same generic success message and status, regardless of whether the account exists. A reset email MUST be sent only when a confirmed account exists.

#### Scenario: Existing account
- GIVEN a confirmed account in app A
- WHEN forgot-password is requested for its email
- THEN a reset email is sent with a single-use link
- AND the response is the generic "if the account exists, an email was sent" message

#### Scenario: Unknown email
- GIVEN no account for the email in app A
- WHEN forgot-password is requested
- THEN no email is sent
- AND the response is identical to the existing-account case

#### Scenario: Account in another app only
- GIVEN the email exists only in app B
- WHEN forgot-password is requested for app A
- THEN no email is sent and the response is the same generic message

### Requirement: Reset token properties

Reset tokens MUST be generated with a cryptographically secure RNG (at least 32 bytes), stored only as a hash, valid for 1 hour, and single-use. A new request MUST invalidate earlier unused reset tokens for that account.

#### Scenario: Valid reset
- GIVEN an unexpired, unused reset token
- WHEN a new valid password is submitted with it
- THEN the password hash is replaced (bcrypt cost >= 12)
- AND the token is marked used
- AND all refresh tokens of the account in that app are revoked

#### Scenario: Token reuse
- GIVEN a token already used
- WHEN it is submitted again
- THEN the request fails with a generic invalid-or-expired error
- AND the password is unchanged

#### Scenario: Expired token
- GIVEN a token older than 1 hour
- WHEN it is submitted
- THEN the request fails with the same generic error

#### Scenario: Superseded token
- GIVEN two reset requests were made
- WHEN the first token is submitted
- THEN it fails as invalid

### Requirement: Change password

The system MUST let an authenticated user change their password by providing the current password and a new one. On success, all refresh tokens for that account in the app MUST be revoked.

#### Scenario: Successful change
- GIVEN a valid access token and the correct current password
- WHEN a new valid password is submitted
- THEN the hash is replaced
- AND all refresh tokens of the account are revoked
- AND a notification email is sent (assumption)

#### Scenario: Wrong current password
- GIVEN a valid access token
- WHEN the current password is wrong
- THEN the change is rejected with a generic error and the password is unchanged

### Requirement: Password handling

Passwords MUST NOT be logged, returned, or stored in plaintext. New passwords MUST meet the same minimum rules as signup.

#### Scenario: Weak new password
- GIVEN a new password shorter than 8 characters
- WHEN reset or change is submitted
- THEN it is rejected with a validation error and no state changes
