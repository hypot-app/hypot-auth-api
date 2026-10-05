# hypot Auth API contract

> **Derived from the specs and design in `openspec/changes/auth-service/` (round 11 contract).** The authoritative OpenAPI document will be generated from code in U19. Any divergence between this document and that one is a bug in one of them: report it.
>
> Paths, bodies, status codes and error codes below are decided. Items marked **(implemented)** match the code merged today. Items marked **(planned)** are decided and not built yet.

Companion: [`integration-guide.md`](./integration-guide.md).

## Conventions

| Topic | Rule |
|-------|------|
| Base URL | `https://<auth-host>`. Business routes live under `/api/v1`. JWKS, `/` and `/health` are at the root. |
| Format | JSON in and out (`Content-Type: application/json`). No forms, no cookies, no redirects, no HTML. |
| Error body | Always `{ "error": "<code>", "message": "<human text>" }`. Branch on `error`, never on `message`. |
| Email | Trimmed and compared case-insensitively (stored lowercase). |
| Password | Min 8 characters, max 72 UTF-8 bytes, no NUL. |
| `client_id` | `app_` plus 32 lowercase hex. Public. |
| Tokens | Access: RS256 JWT, 1 hour. Refresh: opaque, rotating. Both in the JSON body. |
| Malformed body | `400 invalid_request` on every body endpoint (missing field, non-string value, invalid JSON). |
| `Retry-After` | Integer number of seconds, at least 1. |

### Status legend

| Badge | Meaning |
|-------|---------|
| IMPLEMENTED | Merged and running today (U1-U6) |
| IMPLEMENTED (REPLACED) | Running today, will be replaced. Do not build against it. |
| PLANNED | Decided, not implemented yet |

### Error codes

| Status | `error` | Where |
|--------|---------|-------|
| 400 | `invalid_request` | Any body endpoint: malformed body |
| 400 | `invalid_email`, `invalid_password` | Signup (both), reset and change (`invalid_password`) |
| 400 | `invalid_client` | Signup, resend, forgot, refresh: unknown or inactive `client_id`, or (signup, resend, forgot) origin not bound to it |
| 400 | `unconfigured_client` | Signup, resend, forgot: the app has no email URLs |
| 400 | `invalid_or_expired_link` | Confirm, reset: bad token, or a known token from the wrong origin |
| 400 | `invalid_current_password` | Change: wrong current password (also while blocked) |
| 401 | `invalid_credentials` | Login: one identical failure, see below |
| 401 | `invalid_grant` | Refresh: the session or token is gone, or the origin is not bound |
| 401 | `invalid_token` | `/me`, change: missing, expired or bad access token (header `WWW-Authenticate: Bearer`) |
| 429 | `rate_limited` | Signup, resend, forgot, reset, confirm, refresh (never login). Has `Retry-After`. |
| 503 | `temporarily_unavailable` | Credential endpoints when the limiter store is down |

Texts: the fixed `message` strings are listed per endpoint where they are fixed. Other `message` values are human text and not contractual.

### CORS (applies to the 10 API routes)

- Applies to login, refresh, logout, signup, confirm, resend-confirmation, forgot, reset, change and `/me`.
- A request with an `Origin` header is allowed only when the origin exactly matches an allowed origin of the app that the request identifies (body `client_id`, token owner for confirm and reset, token `aud` for `/me` and change).
- Allowed: `Access-Control-Allow-Origin: <origin>` (never `*`) and `Vary: Origin`. Never `Access-Control-Allow-Credentials`. Never `Set-Cookie`.
- Not allowed: no CORS allow header, and the endpoint's own generic outcome (see each endpoint: `invalid_client`, `invalid_credentials`, `invalid_grant`, `invalid_or_expired_link`, `invalid_token`, or `204` with no effect for logout).
- Preflight `OPTIONS`: `204`, answered when the origin belongs to **any** active app (the body is not visible). The actual request is still checked against its own `client_id`. The answer carries exactly:

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | the request origin |
| `Access-Control-Allow-Methods` | `GET, POST, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type, Authorization` (fixed, not echoed) |
| `Access-Control-Max-Age` | `600` |
| `Vary` | `Origin` |

- No `Origin` header (native clients, servers): not CORS-gated.
- Allowed-origin lookups may be cached up to 30 seconds.
- Today the CORS middleware is attached only to legacy routes, not to the account routes. The planned units change that.

### Rate-limit behaviour (summary)

| Scope | Applies to | Over the limit | Defaults (configurable, ADR 36) |
|-------|------------|----------------|--------------------------------|
| Login per IP | login | Generic login `401`, never `429` | 100 / 15 min |
| Login pair (account, IP) | login, change (wrong current password) | Generic `401` for that IP (change: `400 invalid_current_password`) | 5 failures / 15 min, block 15 min |
| Login global (account) | login, change | Generic `401` from any IP (change: same `400`) | 50 failures / 1 h, lock 15 min |
| Email per IP | signup, resend, forgot | `429` + `Retry-After` | 20 / 1 h |
| Reset per IP | reset | `429` + `Retry-After` | 20 / 1 h |
| Confirm per IP | confirm | `429` + `Retry-After` | 20 / 1 h |
| Refresh per (app, IP) | refresh | `429` + `Retry-After` | 60 / 15 min |
| Email per account | signup, resend, forgot | Normal `202`, email silently not sent | 3 / 1 h |
| Store unavailable | credential endpoints | `503` | n/a |

`/me` and logout have no limiter. Client IP comes from the TCP peer unless the operator configures trusted proxies; IPv6 is keyed on its /64. The `429` decision depends only on the IP and the endpoint, never on account or token state. The numbers are configurable defaults: do not hard-code them in your app.

---

## Platform and keys

### `GET /` and `GET /health`

Status: IMPLEMENTED. Operational only. `GET /` returns `200 {"message":"Welcome to the API"}`. `GET /health` returns `200`, or `503` when the database is down. No CORS, no limits.

### `GET /.well-known/jwks.json`

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | none |
| Success | `200` JSON Web Key Set with the public RSA keys (`kid`, `kty`, `n`, `e`, `alg` as published). `Cache-Control: public, max-age=300`. |
| During rotation | Current and previous keys are both published until tokens of the previous key have expired. Private parameters never appear. |
| Errors | none expected |
| CORS | none (consumed server to server) |
| Limits | none |

**Issuer and JWKS URL.** `iss` is exactly the operator-configured `AUTH_PUBLIC_BASE_URL`, and the JWKS URL is `${iss}/.well-known/jwks.json`. In production the value is an `https` URL with no trailing slash, for example `https://auth.example` and `https://auth.example/.well-known/jwks.json`. Copy the strings your operator gives you; they are compared exactly.

**Access token format** (IMPLEMENTED, issued after login in the planned units):

| Part | Value |
|------|-------|
| Header | `alg: RS256`, `typ: at+jwt`, `kid` (present in the JWKS) |
| Claims | `iss`, `aud` (the app `client_id`), `sub` (account id), `iat`, `exp` (`iat` + 3600), `jti` |
| Not present | roles, permissions, name, profile |

---

## Accounts

### `POST /api/v1/accounts/signup`

Status: IMPLEMENTED (limits and browser CORS: PLANNED).

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `202 { "message": "If this address can be registered, a confirmation email is on its way." }`. Fixed text, identical for a new and an existing address. |
| Side effects | New: unconfirmed account (bcrypt cost 12) and a confirmation email (24 h link). Existing: an "account exists" notice with the app's `password_reset_url`, no token. No tokens are issued. |
| Errors | `400 invalid_request`, `400 invalid_email`, `400 invalid_password` (length, 72 bytes, NUL), `400 invalid_client` (unknown or inactive app, origin not bound), `400 unconfigured_client`, `429 rate_limited`, `503 temporarily_unavailable` |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP: `429` + `Retry-After`. Per account: silent, no email |

Validation errors never reveal whether the address exists.

### `POST /api/v1/accounts/confirm`

Status: PLANNED. The current `GET /api/v1/accounts/confirm?token=` is IMPLEMENTED (REPLACED): after the change, `GET` returns `404` and never consumes a token.

| Item | Value |
|------|-------|
| Request | `{ "token": string }`, the value of `#token` from the email link. No `client_id`: the token identifies the app. |
| Success | `200 { "message": "Your email address has been confirmed." }`. The token is marked used and a welcome email is sent. No tokens are issued. |
| Errors | `400 invalid_or_expired_link` for malformed, unknown, used or expired tokens, and for a known token sent from the wrong origin (identical, so it is not an oracle). `400 invalid_request` for a missing or non-string `token`. `429 rate_limited`. |
| CORS | Origin bound to the app that owns the token |
| Limits | Per IP: `429` + `Retry-After`, checked before the token is looked up |

### `POST /api/v1/accounts/resend-confirmation`

Status: IMPLEMENTED (limits and browser CORS: PLANNED).

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string }` |
| Success | `202 { "message": "If an unconfirmed account exists for this address, a new confirmation email is on its way." }`. Fixed text, identical for unknown, unconfirmed and confirmed accounts. |
| Side effects | For an unconfirmed account: new token, previous unused tokens invalidated. |
| Errors | `400 invalid_request`, `400 invalid_client`, `400 unconfigured_client`, `429 rate_limited`, `503 temporarily_unavailable` |
| CORS | Origin bound to body `client_id` |
| Limits | As signup |

### `GET /api/v1/me`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | Header `Authorization: Bearer <access_token>` |
| Success | `200 { "id": string, "email": string, "email_verified": boolean, "created_at": string }`. `id` is the account id and equals the token's `sub`. `created_at` is ISO 8601 UTC. Exactly these four keys. |
| Errors | `401 { "error": "invalid_token", ... }` with `WWW-Authenticate: Bearer`, one identical response for: no token, expired token, bad signature, wrong `typ` or algorithm, missing, unknown or inactive `aud`, unknown account. |
| CORS | Origin bound to the app named by the token `aud` |
| Limits | None. Bearer verification is a local signature check. |

**Profile ownership.** Auth stores identity and credentials only: id, email, verification state and creation time. It has no name, avatar or other profile data. Your app keeps its own profile records and links them to the account by `id` (the `sub` claim).

---

## Session auth

### `POST /api/v1/auth/login`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `200 { "access_token": string, "token_type": "Bearer", "expires_in": 3600, "refresh_token": string }`. No `Set-Cookie`. |
| Errors | `400 invalid_request` for a missing or non-string `email` or `password` (does not mention account state). `401 invalid_credentials`, one identical response (status, body, headers) for: unknown email, wrong password, unconfirmed account, locked account, blocked (account, IP) pair, IP over its limit, unknown or inactive `client_id`, origin not bound to the app. `503 temporarily_unavailable`. |
| CORS | Origin bound to body `client_id`. A mismatch is the generic `401`. |
| Limits | Never `429`. See the rate-limit summary. A request rejected by a limit or block is answered before bcrypt runs. |

The login `401` carries no `WWW-Authenticate` and no `Retry-After`.

### `POST /api/v1/auth/refresh`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `200`, same body shape as login. New access token and new refresh token in the same session. The presented token is marked used. |
| Errors | `401 invalid_grant`, identical for unknown, expired, other-app, revoked and reused tokens (outside the grace rule below), and for an `Origin` not bound to `client_id`. `400 invalid_request`. `400 invalid_client` (unknown or inactive `client_id`). `429 rate_limited`. |
| CORS | Origin bound to body `client_id` |
| Limits | Per (app, IP): `429` + `Retry-After`, checked before the token is looked up. A `429` is not `invalid_grant`: do not log the user out. |

**Reuse and the grace window.** Presenting a token that was already rotated revokes the whole session, with one exception. If a rotated token R1 (rotated into R2) is presented again:

| Case | Result |
|------|--------|
| Within about 10 s of the rotation, from the same client IP (IPv6 /64), R2 not used yet, first time for R1 | `200` with a fresh pair. R2 is revoked, and the session stays active. The raw R2 is never stored or returned. |
| Within the window from a different IP | `401 invalid_grant`, session revoked |
| After the window | `401 invalid_grant`, session revoked |
| A second reuse of R1, even inside the window | `401 invalid_grant`, session revoked |
| R2 was already used | `401 invalid_grant`, session revoked |

The window is configurable (`REFRESH_REUSE_GRACE_SECONDS`, default 10, `0` disables it): do not hard-code it. It exists for lost responses on flaky networks, not for racing tabs: a request that wins a race holds a token that a later grace reuse revokes. Keep serializing refreshes.

Lifetimes: session 30 days absolute from login, not extended by rotation. A token expires after 7 days without use, capped at the session expiry.

### `POST /api/v1/auth/logout`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `204`, no body. Idempotent: the same for an active, used, expired, unknown or other-app token. Revokes the whole session only when the token belongs to `client_id` and any `Origin` is bound to that app. |
| Errors | `400 invalid_request` for a malformed body. An `Origin` not bound to `client_id` still gets `204`, but nothing is revoked and no CORS allow header is sent. |
| CORS | Origin bound to body `client_id` |
| Limits | None |

Access tokens already issued stay valid until `exp` (no denylist).

---

## Password management

### `POST /api/v1/password/forgot`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string }` |
| Success | Always `202 { "message": "If an account exists for this address, an email is on its way." }`. Fixed text, identical whether the account exists, is unconfirmed or exists only in another app. |
| Side effects | Confirmed account in that app: a reset email, link `<password_reset_url>#token=<token>`, valid 1 hour, earlier unused reset tokens invalidated. Unconfirmed account: a **confirmation** email instead (link `<email_confirmation_url>#token=<token>`, 24 h, earlier unused confirmation tokens invalidated), no reset. Unknown or other-app-only: nothing. Every email sent counts toward the per-account cap. |
| Errors | `400 invalid_request`, `400 invalid_client` (unknown or inactive `client_id`, origin not bound, no email sent), `400 unconfigured_client`, `429 rate_limited`, `503 temporarily_unavailable` |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP: `429` + `Retry-After`. Per account: silent, no email |

### `POST /api/v1/password/reset`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "token": string, "new_password": string }`. The token identifies the account and app. |
| Success | `204`, no body, no redirect. Password replaced, token used, **all refresh sessions of the account revoked**. |
| Errors | `400 invalid_or_expired_link` for invalid, expired, used or superseded tokens (and a known token from the wrong origin). `400 invalid_password` for a weak password: the token stays usable. `400 invalid_request`. `429 rate_limited`, `503 temporarily_unavailable`. |
| CORS | Origin bound to the app that owns the token |
| Limits | Per IP: `429` + `Retry-After` |

### `POST /api/v1/password/change`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | Header `Authorization: Bearer <access_token>`, body `{ "current_password": string, "new_password": string }` |
| Success | `204`, no body. Password replaced, **all sessions revoked including the caller's**, a password-changed notice email is sent. The current access token stays valid until `exp`. |
| Errors | `401 invalid_token` for a missing or invalid access token. `400 invalid_request`. `400 invalid_password` for a weak new password (no counter touched). `400 invalid_current_password` for a wrong current password, **never `401`**, so it cannot be mistaken for an expired token. |
| CORS | Origin bound to the app named by the token `aud` |
| Limits | A wrong current password counts as a failed login for both lockout counters. While the (account, IP) pair is blocked or the account is locked, even the correct current password gets the same `400 invalid_current_password`, without bcrypt. |

Order of checks: bearer, body shape, new-password rules, lockout state, current-password comparison.

---

## Routes that must not exist

| Request | Expected |
|---------|----------|
| `GET /api/v1/accounts/confirm`, `GET /api/v1/password/forgot`, `GET /api/v1/password/reset` | `404` |
| `/api/v1/oauth/*` (token, revoke, authorize) | `404` |
| Any app create, update or delete route | `404` |

---

## Open questions

None. The 15 gaps found while drafting this contract were closed by user decisions and spec defaults (round 11). Two things are deliberately non-contractual: the `message` texts that are not listed as fixed, and the numeric limit defaults (they are configurable).
