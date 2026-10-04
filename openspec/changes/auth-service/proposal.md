# Proposal: Auth Service MVP (Phase 1)

## Intent

Every app today would rebuild login, password reset, and auth emails on its own. This change delivers one multi-app Auth service that owns credentials and issues RS256 tokens scoped to each app. App backends never see passwords. Source: `PRD-AUTH.md`, normalized by the binding decisions in `sdd/auth-service/decisions`.

## Normalized Phase Plan

This plan replaces the PRD's conflicting phase lists. The PRD itself stays unedited.

| Phase | Content |
|-------|---------|
| **1 - MVP (this change)** | App registry, accounts, hosted login + forgot/reset pages + PKCE, tokens, JWKS, email flows, one pilot app |
| 2 - Hardening | Rate limiting, lockout, audit logs, monitoring and alerts, apps 2-3, SDK docs |
| 3 - Advanced | 2FA, webhooks, admin panel, session revocation, password policies, GDPR export and delete |
| 4 - Future | Social login, full OIDC, organization multi-tenancy, certifications |

## Scope

### In Scope
- App registry: `client_id`, redirect URIs, allowed origins. Operators manage it through CLI or seed.
- Per-app accounts that are unique on `(app_id, email)`
- Hosted signup and login, plus OAuth2 Authorization Code + PKCE
- Access JWT with `iss`, `aud` set to the app's `client_id`, `kid`, and `sub`. It carries no roles and lives 1h.
- Refresh tokens: stored hashed, rotated on every use, revoked on logout
- JWKS endpoint, so apps can validate tokens locally
- Email verification (24h link, resend supported), forgot and reset password (1h, single-use, hashed), change password
- `GET /api/v1/me`, `/health` (root), OpenAPI
- Welcome, confirmation, and reset emails with per-app templates
- Generic auth errors that never reveal whether an account exists

### Out of Scope
- Everything in Phases 2-4
- Email change, Redis, and access-token denylisting (a 1h revocation window is accepted)
- Roles. Each app owns its own roles.

## Capabilities

### New Capabilities
- `app-registry`: app clients, redirect URIs, allowed origins
- `user-accounts`: per-app registration, email verification, profile
- `authorization-flow`: hosted login and Authorization Code + PKCE
- `token-lifecycle`: issuance, refresh rotation, revocation, JWKS
- `password-management`: change, forgot, and reset password
- `transactional-email`: templated per-app emails

### Modified Capabilities
None (greenfield).

## Approach

The service is a NestJS app on PostgreSQL. It has one module per capability. RS256 keys are identified by `kid` and published through JWKS. Single-use tokens are stored hashed, and passwords use bcrypt with cost 12 or higher. sdd-design decides the ORM, the hosted-UI tech, and the email provider.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/` | New | NestJS service |
| `openspec/specs/*` | New | Six capability specs |
| Pilot app | New | Integrates through PKCE and JWKS |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Credential stuffing before Phase 2 | Med | Expose only the pilot app, and treat Phase 2 as required before more apps |
| The hosted UI and PKCE add scope beyond the PRD's 4 weeks | Med | Keep the UI minimal and unbranded |
| bcrypt load at 1000 req/s | Med | Scale out horizontally and load-test |
| The PRD drifts from these specs | High | The specs are authoritative |

## Rollback Plan

The pilot app keeps its previous login behind a feature flag. Migrations are reversible. If a key is compromised, rotate the `kid` and revoke all refresh tokens.

## Dependencies

- An SMTP account from any provider (host, port, credentials), with no vendor SDK
- A secrets store for the private keys

## Success Criteria

- [ ] The pilot app logs in through PKCE without ever handling a password
- [ ] The same email in two apps gives two independent accounts
- [ ] Apps reject tokens whose `aud` does not match, using JWKS only
- [ ] Refresh rotation works, and logout or a password change revokes refresh tokens
- [ ] No endpoint reveals whether an account exists
- [ ] Login P95 stays under 500ms at pilot load

## Proposal question round

The executor ran in automatic mode, so these assumptions still need user review:
1. App registration is operator-run (CLI or seed) until Phase 3.
2. Refresh reuse detection revokes the whole token family.
3. Both public clients (SPA, mobile) and confidential clients are supported, and PKCE is always required.
4. Unconfirmed users cannot log in (PRD REQ-F02).
