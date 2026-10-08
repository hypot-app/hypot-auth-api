# hypot Auth API contract

> **Derived from the specs and design in `openspec/changes/auth-service/` (round 11 contract).** The authoritative OpenAPI document will be generated from code in U19. Any divergence between this document and that one is a bug in one of them: report it.
>
> Paths, bodies, status codes and error codes below are decided. Items marked **(implemented)** match the code merged today. Items marked **(planned)** are decided and not built yet.

Companion: [`integration-guide.md`](./integration-guide.md).

## Conventions

| Topic | Rule |
|-------|------|
| Base URL | `https://<auth-host>`. Business routes live under `/api/v1`. JWKS, `/` and `/health` are at the root. |
| Format | JSON in and out (`Content-Type: application/json`, parameters such as `; charset=utf-8` allowed). No forms, no cookies, no redirects, no HTML. Every `POST` under `/api/v1` must send that `Content-Type`; anything else, including no `Content-Type`, is `415`. |
| Error body | Always `{ "error": "<code>", "message": "<human text>" }`. Branch on `error`, never on `message`. |
| Email | Trimmed and compared case-insensitively (stored lowercase). |
| Password | Min 8 characters, max 72 UTF-8 bytes, no NUL. |
| `client_id` | `app_` plus 32 lowercase hex. Public. |
| Tokens | Access: RS256 JWT, 1 hour. Refresh: opaque, rotating. Both in the JSON body. |
| Malformed body | `400 invalid_request` on every body endpoint (missing field, non-string value, invalid JSON). |
| `Retry-After` | Integer number of seconds, at least 1. |
| Caching | Every answer of `/api/v1/auth/*` (token responses and errors) carries `Cache-Control: no-store` and `Pragma: no-cache`. |

### Status legend

| Badge | Meaning |
|-------|---------|
| IMPLEMENTED | Merged and running today (U1-U6) |
| IMPLEMENTED (REPLACED) | Running today, will be replaced. Do not build against it. |
| PLANNED | Decided, not implemented yet |

### Error codes

| Status | `error` | Where |
|--------|---------|-------|
| 415 | `unsupported_media_type` | Every `POST` under `/api/v1`: `Content-Type` is not `application/json` (form, multipart, `text/plain`) or missing. Body `{ "error": "unsupported_media_type", "message": "Request body must be JSON." }`. Checked before any limit, lookup or CORS handling, so it never carries an allow header and never counts against a limit. |
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
- Origin matching is exact on the browser-serialised origin (lowercase scheme and host, no trailing slash), so an uppercase `Origin` never matches.
- Allowed: `Access-Control-Allow-Origin: <origin>` (never `*`) and `Vary: Origin`. Never `Access-Control-Allow-Credentials`. Never `Set-Cookie`.
- The allow header is granted only after the origin binding passes (fail-closed), plus on request-validation `400`, `429` and `503` answers from an active app's origin so the client can read them (the `429` and `503` of the rate limiter always carry it, whatever the endpoint: their bodies hold no app data). Binding rejections and `500` never carry it.
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
- Today the CORS middleware covers all 10 routes and the preflight answer above is live. The origin binding of the actual request is live for signup, resend-confirmation (`400 invalid_client`, no allow header) and confirm (generic `invalid_or_expired_link`, no allow header); the other endpoints get it in their own units.

### Rate-limit behaviour (summary)

| Scope | Applies to | Over the limit | Defaults (configurable, ADR 36) |
|-------|------------|----------------|--------------------------------|
| Login per IP | login | Generic login `401`, never `429` | 100 / 15 min |
| Login pair (account, IP) | login, change (wrong current password) | Generic `401` for that IP (change: `400 invalid_current_password`) | 5 attempts / 15 min (counted before the password check), block 15 min |
| Login global (account) | login, change | Generic `401` from any IP (change: same `400`) | 50 attempts per window (1 h); reaching it locks the account for 15 min, then the count restarts (about 200 attempts / h / account at most, see below) |
| Email per IP | signup, resend, forgot | `429` + `Retry-After` | 20 / 1 h |
| Reset per IP | reset | `429` + `Retry-After` | 20 / 1 h |
| Confirm per IP | confirm | `429` + `Retry-After` | 20 / 1 h |
| Refresh per (app, IP) | refresh | `429` + `Retry-After` | 60 / 15 min |
| Email per account | signup, resend, forgot | Normal `202`, email silently not sent | 3 / 1 h |
| Store unavailable | credential endpoints | `503` | n/a |

Real login throughput. Both login counters count attempts (successful ones too), and each lock lasts 15 min, shorter than the 1 h window, so a count restarts when its lock ends. The pair counter allows 5 attempts per lock cycle, about 20 per hour sustained for one account and IP. The account counter allows 50 attempts per cycle of 15 min, so a distributed attacker gets at most about 200 attempts per hour per account (about 250 in a closed hour, counting a burst at each end), and needs at least 10 distinct IPs (or IPv6 /64 prefixes) to reach it. A success refunds only the pair counter. `POST /password/change` shares both counters. An account that is logged into more than 50 times an hour locks itself for 15 min.

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

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `202 { "message": "If this address can be registered, a confirmation email is on its way." }`. Fixed text, identical for a new and an existing address. |
| Side effects | New: unconfirmed account (bcrypt cost 12) and a confirmation email (24 h link). Existing: an "account exists" notice with the app's `password_reset_url`, no token. No tokens are issued. |
| Errors | `400 invalid_request`, `400 invalid_email`, `400 invalid_password` (length, 72 bytes, NUL), `400 invalid_client` (unknown or inactive app, origin not bound), `400 unconfigured_client`, `429 rate_limited`, `503 temporarily_unavailable` |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP (and app): `429` + `Retry-After`, identical for a new and an existing address, checked before any password hashing or account lookup. Per account (3 emails per hour, shared with resend and forgot): the answer stays the usual `202`; a new account is still created but no email is sent. |

Validation errors never reveal whether the address exists. `unconfigured_client` describes the app (it lacks `email_confirmation_url` or `password_reset_url`), is raised before any account work, and never depends on the address.

### `POST /api/v1/accounts/confirm`

Status: IMPLEMENTED. It replaces the former `GET /api/v1/accounts/confirm?token=`: `GET` now returns `404` and never consumes a token, so mail scanners and link prefetchers cannot confirm accounts.

| Item | Value |
|------|-------|
| Request | `{ "token": string }`, the value of `#token` from the email link. No `client_id`: the token identifies the app. |
| Success | `200 { "message": "Your email address has been confirmed." }`. The token is marked used and a welcome email is sent. No tokens are issued. |
| Errors | `400 invalid_or_expired_link` for malformed, unknown, used or expired tokens, and for a known token sent from the wrong origin (identical, so it is not an oracle). `400 invalid_request` for a missing or non-string `token`. `429 rate_limited`. |
| CORS | Origin bound to the app that owns the token. The allow header is sent on `200`, and on the `400 invalid_or_expired_link` of a token that belongs to the origin's own app (used or expired). A malformed or unknown token, a token of another app, or a known token from an unbound origin gets no allow header. The body is identical in every case (`invalid_or_expired_link`); only the allow header differs, and only for the owning app's origin. A browser page that is not the owner sees an opaque network/CORS error, not a readable `400`: integrators must treat a network error on confirm like `invalid_or_expired_link`. |
| Limits | Per IP: `429` + `Retry-After`, checked before the token is looked up |

### `POST /api/v1/accounts/resend-confirmation`

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string }` |
| Success | `202 { "message": "If an unconfirmed account exists for this address, a new confirmation email is on its way." }`. Fixed text, identical for unknown, unconfirmed and confirmed accounts. |
| Side effects | For an unconfirmed account: new token, previous unused tokens invalidated. |
| Errors | `400 invalid_request`, `400 invalid_client`, `400 unconfigured_client`, `429 rate_limited`, `503 temporarily_unavailable` |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP (and app): `429` + `Retry-After`, checked before the account is looked up. Per account: the usual `202` and no email once the cap is reached; requests for unknown addresses count too. |

### `GET /api/v1/me`

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | Header `Authorization: Bearer <access_token>` |
| Success | `200 { "id": string, "email": string, "email_verified": boolean, "created_at": string }`. `id` is the account id and equals the token's `sub`. `created_at` is ISO 8601 UTC. Exactly these four keys. `Cache-Control: no-store`, `Pragma: no-cache`. |
| Errors | `401 { "error": "invalid_token", ... }` with `WWW-Authenticate: Bearer`, one identical response for: no token, expired token, bad signature, wrong `typ` or algorithm, missing, unknown or inactive `aud`, unknown account, an account of another app than the token's `aud`, an `Origin` that is not an allowed origin of the `aud` app. Body: `{ "error": "invalid_token", "message": "Missing or invalid access token" }`. Never an allow header. |
| CORS | Origin bound to the app named by the token `aud` |
| Limits | None. Bearer verification is a local signature check. |

**Profile ownership.** Auth stores identity and credentials only: id, email, verification state and creation time. It has no name, avatar or other profile data. Your app keeps its own profile records and links them to the account by `id` (the `sub` claim).

---

## Session auth

### `POST /api/v1/auth/login`

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `200 { "access_token": string, "token_type": "Bearer", "expires_in": 3600, "refresh_token": string }`. No `Set-Cookie`. `Cache-Control: no-store`, `Pragma: no-cache`. |
| Errors | `400 invalid_request` for a missing or non-string `email` or `password` (does not mention account state). `401 invalid_credentials`, one identical response (status, body, headers) for: unknown email, wrong password, unconfirmed account, locked account, blocked (account, IP) pair, IP over its limit, unknown or inactive `client_id`, origin not bound to the app. `503 temporarily_unavailable`. |
| CORS | Origin bound to body `client_id`. A mismatch is the generic `401` with no allow header. Once the binding passes, every answer (`200`, the generic `401`, the request-validation `400`) carries the allow header; an unknown `client_id` or an origin not bound to it never does. |
| Limits | Never `429`. See the rate-limit summary. A request rejected by a limit or block is answered before bcrypt runs. |

The login `401` is `{ "error": "invalid_credentials", "message": "Email or password is incorrect." }`. It carries no `WWW-Authenticate` and no `Retry-After`. The `400` is `{ "error": "invalid_request", "message": "client_id, email and password must be strings" }`. The session lasts 30 days from login (`REFRESH_ABSOLUTE_TTL_SECONDS`) and the refresh token 7 days without use (`REFRESH_IDLE_TTL_SECONDS`).

### `POST /api/v1/auth/refresh`

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `200`, same body shape as login. New access token and new refresh token in the same session. The presented token is marked used. |
| Errors | `401 invalid_grant`, identical for unknown, expired, other-app, revoked and reused tokens (outside the grace rule below), and for an `Origin` not bound to `client_id`. `400 invalid_request`. `400 invalid_client` (unknown or inactive `client_id`). `429 rate_limited`. |
| CORS | Origin bound to body `client_id`. An `Origin` not bound to it gets the `401 invalid_grant` with no allow header, and the token is not consumed. Once the binding passes, the `200`, the `401`, the request-validation `400` and the `429` carry the allow header; `invalid_client` and a `500` never do. |
| Limits | Per (app, IP): `429` + `Retry-After`, checked before the token is looked up. A `429` is not `invalid_grant`: do not log the user out. |
| Headers | Every answer, errors included, carries `Cache-Control: no-store` and `Pragma: no-cache`. |

The `401` is `{ "error": "invalid_grant", "message": "The refresh token is invalid or has expired." }` and the `400` is `{ "error": "invalid_request", "message": "client_id and refresh_token must be strings" }`. Every successful refresh also records the session as used (`last_used_at`).

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

Status: IMPLEMENTED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `204`, no body. Idempotent: the same for an active, used, expired, unknown or other-app token. Revokes the whole session only when the token belongs to `client_id` and any `Origin` is bound to that app. |
| Errors | `400 invalid_request` for a malformed body. An `Origin` not bound to `client_id` still gets `204`, but nothing is revoked and no CORS allow header is sent. |
| CORS | Origin bound to body `client_id` |
| Limits | None |
| Headers | Every answer, the `400` included, carries `Cache-Control: no-store` and `Pragma: no-cache`. |

`400` is `{ "error": "invalid_request", "message": "client_id and refresh_token must be strings" }`. An unknown or inactive `client_id` also gets `204`, with no effect and no allow header. The allow header is sent on the `204` and on the `400` only once the origin is bound to `client_id`.

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
