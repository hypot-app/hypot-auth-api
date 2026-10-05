# Proposal: Auth Service MVP (Phase 1), API-only revision

## Intent

One multi-app Auth service owns credentials and issues RS256 tokens scoped to each app, so apps stop rebuilding login, reset and auth email. Revision 2 (`decisions-round8`, `decisions-round9`): Auth is **API-only**. Each app builds its own UI. Its frontend calls Auth directly with its `client_id` and receives access and refresh tokens.

**Why a direct credential flow (first-party, ROPC-like) is acceptable**
- All apps belong to the same company. There are no third-party clients.
- Passwords go browser to Auth. App backends never see them.

**Accepted trade-offs**
- No SSO across apps (accounts are per-app anyway).
- App frontends handle the password field, so an XSS in an app can capture it.
- Third-party or SSO needs reopen OAuth in Phase 4.

## Phase Plan

| Phase | Content |
|-------|---------|
| **1 - MVP** | Done (U1-U6): platform, app registry, email outbox, signup and confirm, keys, JWKS, access-token issuer. Remaining: abuse protection, login/refresh/logout, password management, `/me`, per-app email links, pilot app |
| 2 - Hardening | Audit logs, monitoring and alerts, expired-token and outbox cleanup, apps 2-3, SDK docs |
| 3 - Advanced | 2FA, webhooks, admin panel, session management, password policies, GDPR |
| 4 - Future | Optional OAuth Code + PKCE and hosted login (third parties, SSO), social login, OIDC, org tenancy |

## Scope

### In Scope (remaining Phase 1)
- `POST /api/v1/auth/login`, `/auth/refresh`, `/auth/logout` (JSON). Refresh rotates on every use; reuse revokes the family.
- Per-IP and per-account rate limits plus temporary lockout on login, signup, resend, forgot and reset (Postgres-backed)
- `POST /accounts/confirm` with the token in the body (replaces the GET)
- Forgot, reset and change password as JSON endpoints
- Per-app `email_confirmation_url` and `password_reset_url`; `post_reset_redirect_uri` dropped
- CORS on login, refresh, logout, signup, confirm, resend, forgot and reset
- `GET /api/v1/me`, OpenAPI, E2E suite, pilot integration
- https `AUTH_PUBLIC_BASE_URL` in production (salvaged from U7a)

### Out of Scope
- Any HTML page or view, and page CSP or CSRF
- OAuth authorize and token endpoints, and PKCE (Phase 4)
- Redis, an access-token denylist (a 1h window is accepted), roles, email change

## Capabilities

### New Capabilities
- `session-auth`: login, refresh rotation and logout. A refresh-token family is a session. It replaces `authorization-flow`.
- `abuse-protection`: per-IP and per-account limits and lockout, with responses identical to normal failures

### Modified Capabilities
- `token-lifecycle`: narrowed to keys, JWKS and access-token issue and verify. Code exchange is removed, and refresh moves to `session-auth`.
- `app-registry`: email link URLs, the post-reset URI removed, CORS on the credential endpoints with the origin bound to `client_id`
- `user-accounts`: confirm becomes a POST, so mail scanners cannot consume links; adds `/me`
- `password-management`: JSON endpoints only, no hosted pages
- `transactional-email`: links are built from the app's URLs

### Removed Capabilities
- `authorization-flow`

**Why `session-auth` and not `token-lifecycle`:** `token-lifecycle` is built and stable (U6) and is pure crypto. Login, refresh and logout carry credential, lockout and session rules that change for different reasons. Keeping them apart keeps `token-lifecycle` closed.

## Approach

- Discard the unmerged U7 branches. The first new unit re-applies the https rule and its tests. The U7 login ordering (dummy bcrypt hash, no early return) is reused as a design reference, not cherry-picked.
- Rate limiting: Postgres counters keyed by `(client_id, IP)` and `(client_id, email hash)`. Lockout is tracked for unknown emails too, so it cannot reveal accounts.
- The refresh token travels in the JSON body. SPA guidance: keep the access token in memory and rely on refresh rotation. An httpOnly refresh cookie stays a discussion item because it brings CSRF back.
- Email links carry the token in the URL fragment, so it never reaches app servers or Referer headers.

## Sizing Note

The U3-U7 forecasts totalled 2,810 lines. The actual total was about 10,300 lines, between 2.8x and 4.3x per unit (median about 3.6x), and tests made up 55-60% of it. Remaining forecasts must apply a **3.5-4x** multiplier and plan 2-3 PRs per unit.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Credential stuffing from any allowed origin | High | Phase 1 limits and lockout, generic errors, alerts in Phase 2 |
| CORS on credential endpoints | Med | The origin must belong to the app of the `client_id`; no `credentials: include` |
| Token theft in an SPA (XSS) | Med | In-memory storage, 1h access token, rotation with reuse detection |
| Email bombing (signup, resend, forgot) | Med | Per-account and per-IP limits; one live token per purpose |
| Lockout used as a DoS against a victim | Med | Short temporary lockout; IP limits throttle the attacker first |
| Forecasts overrun again | High | The 3.5-4x multiplier |

## Rollback Plan

Units merge separately, and every migration is reversible. The pilot app keeps its old login behind a flag. If a key is compromised, rotate the `kid` and revoke all refresh families.

## Dependencies

- An SMTP account and a secrets store for the signing keys
- The pilot team builds its own login, confirm and reset UI

## Success Criteria

- [ ] The pilot SPA logs in, refreshes and logs out over JSON, and its backend never sees a password
- [ ] The same email in two apps gives two independent accounts
- [ ] Apps reject tokens with the wrong `aud`, using JWKS only
- [ ] Refresh reuse revokes the family, and a password change or reset revokes all sessions
- [ ] Login limits and lockout trigger with the same generic `401` as a failed login; IP-only limits on signup, resend, forgot and reset return `429` with `Retry-After` and never depend on account state; per-account email caps stay silent
- [ ] A mail scanner fetching a link consumes nothing
- [ ] No endpoint reveals whether an account exists; login P95 stays under 500ms at pilot load

## Proposal Question Round

This ran in automatic mode. These assumptions need user review:
1. Unconfirmed users cannot log in.
2. Lockout uses two counters (decisions-round10): 5 failures in 15 minutes per (account, IP) blocks that IP for 15 minutes, and 50 failures in 1 hour per account locks the account for 15 minutes. All values are configurable.
3. Native mobile clients use the same endpoints without an `Origin` header.
4. Both email link URLs are required for an app to use signup and password reset.
