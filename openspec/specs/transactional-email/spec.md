# Transactional Email Specification

## Purpose

Per-app templated emails for confirmation, welcome, and password reset. Links point to the app's own frontend, never to a page hosted by Auth.

## Requirements

### Requirement: Email types

The system MUST send: account confirmation, welcome (after confirmation), password reset, a duplicate-signup ("account exists") notice, and (assumption) a password-changed notice. The account-exists notice MUST suggest logging in or resetting the password, MUST link to the app's `password_reset_url` WITHOUT a token, and MUST NOT contain a token.

#### Scenario: Confirmation on signup
- GIVEN a new registration in app A
- WHEN the account is created
- THEN a confirmation email with a 24h link is sent to the address

### Requirement: Per-app templates

Each app MUST be able to configure template content (sender name, subject, body text) and MAY override the from address (`apps.email_from`). Without an override, the global `MAIL_FROM` applies. Without a custom template, a default template MUST be used. Templates MUST NOT allow script execution; variables MUST be escaped.

#### Scenario: Custom template
- GIVEN app A has a custom confirmation template
- WHEN a user of app A registers
- THEN the email uses app A's template

#### Scenario: Default fallback
- GIVEN app B has no custom template
- WHEN a user of app B requests a password reset
- THEN the default template is used

### Requirement: Link construction

Confirmation links MUST be the app's `email_confirmation_url` and reset links MUST be the app's `password_reset_url`, with the raw single-use token appended in the URL FRAGMENT as `#token=<token>`, so the token never reaches servers, logs or Referer headers. Links MUST NOT be built from `AUTH_PUBLIC_BASE_URL` or any request value, and MUST NOT target hosted Auth pages (none exist). Emails MUST NOT contain passwords or hashes, and tokens MUST NOT be logged. `AUTH_PUBLIC_BASE_URL` stays the issuer/JWKS public URL only.

#### Scenario: Confirmation link
- GIVEN app A has `email_confirmation_url=https://a.example/confirm`
- WHEN a confirmation email is rendered
- THEN the link is `https://a.example/confirm#token=<token>`

#### Scenario: Reset link
- GIVEN app A has `password_reset_url=https://a.example/reset`
- WHEN a reset email is rendered
- THEN the link is `https://a.example/reset#token=<token>`

#### Scenario: Account-exists notice
- GIVEN a duplicate signup in app A
- WHEN the notice is rendered
- THEN it links to `https://a.example/reset` with no fragment and no token

#### Scenario: Email content
- GIVEN any outgoing auth email
- WHEN its body is inspected
- THEN it has no password and no `AUTH_PUBLIC_BASE_URL` link

### Requirement: Provider abstraction and failure handling

Delivery MUST go through a provider interface. Phase 1 MUST use generic SMTP configured only by `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. A provider failure MUST NOT alter the HTTP response (no enumeration) and MUST be logged without secrets. (Assumption: retry strategy is a design decision; bounces are Phase 2.)

#### Scenario: Provider outage during forgot-password
- GIVEN the email provider is failing
- WHEN forgot-password is requested for an existing account
- THEN the response is still the generic 202
- AND the failure is logged without token or password

## Out of Scope (Deferred)

| Item | Phase |
|------|-------|
| Audit logs, monitoring and alerts, apps 2-3, SDK docs | 2 |
| 2FA, webhooks, admin panel, session management UI, password policies, GDPR | 3 |
| OAuth Code + PKCE, hosted login, social login, OIDC, org tenancy | 4 |
| Email change, Redis, access-token denylist, roles in tokens | Not planned in Phase 1 |

(Rate limiting and lockout moved into Phase 1: see `abuse-protection`.)

#### Scenario: Deferred features absent
- GIVEN the Phase 1 release
- WHEN the API surface is reviewed
- THEN no endpoints for 2FA, webhooks, admin, social login, email change, or OAuth authorize/token exist
