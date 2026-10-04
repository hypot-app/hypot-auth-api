# Transactional Email Specification

## Purpose

Per-app templated emails for confirmation, welcome, and password reset.

## Requirements

### Requirement: Email types

The system MUST send these emails: account confirmation, welcome (after confirmation), password reset, a duplicate-signup ("account exists / signup attempt") notice, and (assumption) a password-changed notice. The duplicate-signup notice MUST suggest logging in or resetting the password, MUST link to the hosted forgot-password page `${AUTH_PUBLIC_BASE_URL}/password/forgot?client_id=...`, and MUST NOT contain a token.

#### Scenario: Confirmation on signup
- GIVEN a new registration in app A
- WHEN the account is created
- THEN a confirmation email with a 24h link is sent to the address

### Requirement: Per-app templates

Each app MUST be able to configure template content (sender name, subject, body text) and MAY override the from address (`apps.email_from`). When no override is set, the global `MAIL_FROM` default applies. Apps MUST NOT store a link base. When an app has no custom template, the system MUST use a default template. Templates MUST NOT allow arbitrary script execution; variables MUST be escaped.

#### Scenario: Custom template
- GIVEN app A has a custom confirmation template
- WHEN a user of app A registers
- THEN the email uses app A's template

#### Scenario: Default fallback
- GIVEN app B has no custom template
- WHEN a user of app B requests a password reset
- THEN the default template is used

### Requirement: Link safety

Links MUST contain only the raw single-use token and MUST be built from the single global `AUTH_PUBLIC_BASE_URL` setting (the public URL of the Auth host), for example `${AUTH_PUBLIC_BASE_URL}/accounts/confirm?token=...` and `${AUTH_PUBLIC_BASE_URL}/password/reset?token=...&client_id=...`. Non-token links (the `account-exists` deep link to `${AUTH_PUBLIC_BASE_URL}/password/forgot?client_id=...`) carry only the public `client_id`. Emails MUST NOT contain passwords or password hashes. Tokens MUST NOT be logged.

#### Scenario: Account-exists deep link
- GIVEN a duplicate signup in app A
- WHEN the `account-exists` notice is rendered
- THEN it links to `${AUTH_PUBLIC_BASE_URL}/password/forgot?client_id=<A>`
- AND it contains no token

#### Scenario: Email content
- GIVEN any outgoing auth email
- WHEN its body is inspected
- THEN it contains no password
- AND any link starts with `AUTH_PUBLIC_BASE_URL` and targets the Auth host
- AND no per-app link base is used

### Requirement: Provider abstraction and failure handling

Email delivery MUST go through a provider interface. The Phase 1 implementation MUST use generic SMTP, configured only through environment settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`), so any SMTP-capable provider works with no vendor SDK. A provider failure MUST NOT alter the HTTP response (preserving no-enumeration) and MUST be logged without secrets. (Assumption: retry/queue strategy is a design decision; bounce handling is Phase 2.)

#### Scenario: Provider outage during forgot-password
- GIVEN the email provider is failing
- WHEN forgot-password is requested for an existing account
- THEN the response is still the generic success message
- AND the failure is logged without token or password

## Out of Scope (Deferred)

The following MUST NOT be delivered in this change.

| Item | Phase |
|------|-------|
| Rate limiting, account lockout, audit logs, monitoring and alerts, apps 2-3, SDK docs | 2 |
| 2FA, webhooks, admin panel/HTTP app management, session revocation, password policies, GDPR export/delete | 3 |
| Social login, full OIDC, organization multi-tenancy, certifications | 4 |
| Email change, Redis, access-token denylisting, roles/permissions in tokens | Not planned in Phase 1 |

#### Scenario: Deferred features absent
- GIVEN the Phase 1 release
- WHEN the API surface is reviewed
- THEN no endpoints for 2FA, webhooks, admin, social login, or email change exist
