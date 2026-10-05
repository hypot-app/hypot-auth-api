# hypot Auth API contract (draft)

> **Draft derived from the specs in `openspec/changes/auth-service/`.** The authoritative OpenAPI document will be generated from code in U19. Any divergence between this draft and that document is a bug in one of them: report it.
>
> Paths, bodies and status codes come from the specs. Error `code` names marked **(design)** come from `design.md`, not from a spec, and may change. Anything the specs do not define is listed in [Open questions](#open-questions) and is not invented here.

Companion: [`integration-guide.md`](./integration-guide.md).

## Conventions

| Topic | Rule |
|-------|------|
| Base URL | `https://<auth-host>`. Business routes live under `/api/v1`. JWKS, `/` and `/health` are at the root. |
| Format | JSON in and out (`Content-Type: application/json`). No forms, no cookies, no redirects, no HTML. |
| Error body | `{ "error": "<code>", "message": "<text>" }`, as implemented today on signup, confirm and resend. Branch on `error`. See OQ-1 for the planned endpoints. |
| Email | Trimmed and compared case-insensitively (stored lowercase). |
| Password | Min 8 characters, max 72 UTF-8 bytes, no NUL. |
| `client_id` | `app_` plus 32 lowercase hex. Public. |
| Tokens | Access: RS256 JWT, 1 hour. Refresh: opaque, rotating. Both in the JSON body. |

### Status legend

| Badge | Meaning |
|-------|---------|
| IMPLEMENTED | Merged and running today (U1-U6) |
| IMPLEMENTED (REPLACED) | Running today, will be replaced. Do not build against it. |
| PLANNED | Specified, not implemented yet |

### CORS (applies to the 10 API routes)

- Applies to login, refresh, logout, signup, confirm, resend-confirmation, forgot, reset, change and `/me`.
- A request with an `Origin` header is allowed only when the origin exactly matches an allowed origin of the app that the request identifies (body `client_id`, token owner for confirm and reset, token `aud` for `/me` and change).
- Allowed: `Access-Control-Allow-Origin: <origin>` (never `*`). Never `Access-Control-Allow-Credentials`. Never `Set-Cookie`.
- Not allowed: no CORS allow header, and the request is rejected with the generic invalid-client error for that endpoint.
- Preflight `OPTIONS`: `204`, answered when the origin belongs to **any** active app (the body is not visible). The actual request is still checked against its own `client_id`. The current middleware answers methods `GET, POST, OPTIONS`, echoes the requested headers (default `Content-Type, Authorization`) and `Access-Control-Max-Age: 600`. See OQ-14.
- No `Origin` header (native clients, servers): not CORS-gated.
- Allowed-origin lookups may be cached up to 30 seconds.
- Today the CORS middleware is attached only to legacy routes, not to the account routes. The planned units change that.

### Rate-limit behaviour (summary)

| Scope | Applies to | Over the limit | Defaults (configurable, from design) |
|-------|------------|----------------|--------------------------------------|
| Login per IP | login | Generic login `401`, never `429` | 100 / 15 min |
| Login pair (account, IP) | login, change (wrong current password) | Generic `401` for that IP | 5 failures / 15 min, block 15 min |
| Login global (account) | login, change | Generic `401` from any IP | 50 failures / 1 h, lock 15 min |
| Email per IP | signup, resend, forgot | `429` + `Retry-After` | 20 / 1 h |
| Reset per IP | reset | `429` + `Retry-After` | 20 / 1 h |
| Email per account | signup, resend, forgot | Normal `202`, email silently not sent | 3 / 1 h |
| Store unavailable | credential endpoints | `503` | n/a |

Client IP comes from the TCP peer unless the operator configures trusted proxies. The `429` decision depends only on the IP and the endpoint, never on account state. The numeric defaults are in `design.md` (ADR 36), not in the specs: treat them as non-contractual.

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

**Access token format** (IMPLEMENTED, issued after login in the planned units):

| Part | Value |
|------|-------|
| Header | `alg: RS256`, `typ: at+jwt`, `kid` (present in the JWKS) |
| Claims | `iss` (the Auth issuer URL), `aud` (the app `client_id`), `sub` (account id), `iat`, `exp` (`iat` + 3600), `jti` |
| Not present | roles, permissions |

---

## Accounts

### `POST /api/v1/accounts/signup`

Status: IMPLEMENTED (limits and browser CORS: PLANNED).

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `202 { "message": "If this address can be registered, a confirmation email is on its way." }`. Identical for a new and an existing address. |
| Side effects | New: unconfirmed account (bcrypt cost 12) and a confirmation email (24 h link). Existing: an "account exists" notice with the app's `password_reset_url`, no token. No tokens are issued. |
| Errors | `400 invalid_request` (fields missing or not strings), `400 invalid_email`, `400 invalid_password` (length, 72 bytes, NUL), `400 invalid_client` (unknown or inactive app, origin not bound), `400 unconfigured_client` **(design)**, `429 rate_limited` **(design)**, `503 temporarily_unavailable` **(design)** |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP: `429` + `Retry-After`. Per account: silent, no email |

Validation errors never reveal whether the address exists.

### `POST /api/v1/accounts/confirm`

Status: PLANNED. The current `GET /api/v1/accounts/confirm?token=` is IMPLEMENTED (REPLACED): after the change, `GET` returns `404` and never consumes a token.

| Item | Value |
|------|-------|
| Request | `{ "token": string }`, the value of `#token` from the email link. No `client_id`: the token identifies the app. |
| Success | Account confirmed, token marked used, welcome email sent. Status and body are not specified (OQ-4). |
| Errors | `400 invalid_or_expired_link` **(design)** for malformed, unknown, used or expired tokens, and for a known token sent from the wrong origin (identical, so it is not an oracle). `400 invalid_request` for a missing token field. |
| CORS | Origin bound to the app that owns the token |
| Limits | None specified (OQ-9) |

### `POST /api/v1/accounts/resend-confirmation`

Status: IMPLEMENTED (limits and browser CORS: PLANNED).

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string }` |
| Success | `202 { "message": "If an unconfirmed account exists for this address, a new confirmation email is on its way." }`. Identical for unknown, unconfirmed and confirmed accounts. |
| Side effects | For an unconfirmed account: new token, previous unused tokens invalidated. |
| Errors | `400 invalid_request`, `400 invalid_client`, `400 unconfigured_client` **(design)**, `429 rate_limited` **(design)**, `503 temporarily_unavailable` **(design)** |
| CORS | Origin bound to body `client_id` |
| Limits | As signup |

### `GET /api/v1/me`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | Header `Authorization: Bearer <access_token>` |
| Success | `200` with the profile of the token's account: `sub`, email and confirmation state. Field names are not specified (OQ-5). No password hash or internal fields. |
| Errors | `401` with one generic error for: no token, expired token, bad signature, wrong `typ` or algorithm, missing, unknown or inactive `aud`. |
| CORS | Origin bound to the app named by the token `aud` |
| Limits | None specified |

---

## Session auth

### `POST /api/v1/auth/login`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string, "password": string }` |
| Success | `200 { "access_token": string, "token_type": "Bearer", "expires_in": 3600, "refresh_token": string }`. No `Set-Cookie`. |
| Errors | `400` validation error for a missing or non-string `email` or `password` (does not mention account state). `401 invalid_credentials` **(design)**, one identical response (status, body, headers) for: unknown email, wrong password, unconfirmed account, locked account, blocked (account, IP) pair, IP over its limit, unknown or inactive `client_id`, origin not bound to the app. `503 temporarily_unavailable` **(design)**. |
| CORS | Origin bound to body `client_id`. A mismatch is the generic `401`. |
| Limits | Never `429`. See the rate-limit summary. A request rejected by a limit or block is answered before bcrypt runs. |

### `POST /api/v1/auth/refresh`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `200`, same body shape as login. New access token and new refresh token in the same session. The presented token is marked used. |
| Errors | `401 invalid_grant`, identical for unknown, expired, other-app, used and revoked tokens. Presenting a used or revoked token also revokes the whole session. Concurrent use of one token counts as reuse (no grace window). Origin mismatch: see OQ-6. |
| CORS | Origin bound to body `client_id` |
| Limits | None specified (OQ-9) |

Lifetimes (assumptions): session 30 days absolute from login, not extended by rotation. A token expires after 7 days without use, capped at the session expiry.

### `POST /api/v1/auth/logout`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "refresh_token": string }` |
| Success | `204`, no body. Idempotent: the same for an active, used, expired, unknown or other-app token. Revokes the whole session only when the token belongs to `client_id`. |
| Errors | Malformed body and origin mismatch: see OQ-6. |
| CORS | Origin bound to body `client_id` |
| Limits | None specified |

Access tokens already issued stay valid until `exp` (no denylist).

---

## Password management

### `POST /api/v1/password/forgot`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "client_id": string, "email": string }` |
| Success | Always `202` with one generic body, whether the account exists, is unconfirmed or exists only in another app. The exact body is not specified (OQ-3). |
| Side effects | A reset email only for a confirmed account of that app. The link is `<password_reset_url>#token=<token>`. Valid 1 hour. Invalidates earlier unused reset tokens of the account. |
| Errors | `400 invalid_client` (unknown or inactive `client_id`, origin not bound, no email sent), `400 unconfigured_client` **(design)**, `429 rate_limited` **(design)**, `503 temporarily_unavailable` **(design)** |
| CORS | Origin bound to body `client_id` |
| Limits | Per IP: `429` + `Retry-After`. Per account: silent, no email |

### `POST /api/v1/password/reset`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | `{ "token": string, "new_password": string }`. The token identifies the account and app. |
| Success | `204`, no body, no redirect. Password replaced, token used, **all refresh sessions of the account revoked**. |
| Errors | `400 invalid_or_expired_link` **(design)** for invalid, expired, used or superseded tokens (and a known token from the wrong origin). `400` validation error for a weak password: the token stays usable. `429 rate_limited` **(design)**, `503 temporarily_unavailable` **(design)**. |
| CORS | Origin bound to the app that owns the token |
| Limits | Per IP: `429` + `Retry-After` |

### `POST /api/v1/password/change`

Status: PLANNED.

| Item | Value |
|------|-------|
| Request | Header `Authorization: Bearer <access_token>`, body `{ "current_password": string, "new_password": string }` |
| Success | `204`, no body. Password replaced, **all sessions revoked including the caller's**, a password-changed notice email is sent (assumption). The current access token stays valid until `exp`. |
| Errors | `401` generic for a missing or invalid access token. Wrong current password: the generic invalid-credentials error `invalid_credentials` **(design)**, status not specified (OQ-7). `400` validation error for a weak new password. |
| CORS | Origin bound to the app named by the token `aud` |
| Limits | A wrong current password counts as a failed login for lockout. Behaviour while blocked is not specified (OQ-8). |

---

## Routes that must not exist

| Request | Expected |
|---------|----------|
| `GET /api/v1/accounts/confirm`, `GET /api/v1/password/forgot`, `GET /api/v1/password/reset` | `404` |
| `/api/v1/oauth/*` (token, revoke, authorize) | `404` |
| Any app create, update or delete route | `404` |

---

## Open questions

These are ambiguities, contradictions or gaps found while deriving this draft. Nothing here is invented: each item needs a decision from the spec owners.

| # | Gap | Impact on app developers |
|---|-----|--------------------------|
| OQ-1 | **Error body shape for the planned endpoints.** Specs say "generic error" and name only a few codes. Today's signup, confirm and resend return `{error, message}` with codes from design. | Apps need a stable `error` field to branch on. |
| OQ-2 | **Login `401` and validation `400` codes and bodies** are not in the spec. Design names `invalid_credentials`. The code for login `400` is unspecified (`invalid_request` is used by signup today). Also `Retry-After` or `WWW-Authenticate` headers on `401` are unspecified. | UIs cannot distinguish a malformed body from a credential failure by code alone. |
| OQ-3 | **Exact `202` bodies** for signup, resend and forgot are generic by rule. Signup and resend have a message today. Forgot is unspecified. | Low. Apps should ignore the body. |
| OQ-4 | **Confirm success response**: the spec says the account is confirmed but not the status or body (today's GET returns `200 {"message"}`). `204` is used for reset and logout. | Apps need to know whether to parse a body. |
| OQ-5 | **`/me` field names**: "`sub`, email, confirmation state" without exact JSON keys (`email_verified`? `confirmed`?). | Frontends cannot code against `/me` yet. |
| OQ-6 | **Origin mismatch on refresh and logout.** Design says non-login body endpoints return `400 invalid_client` on an unbound origin, but the logout spec says it ALWAYS returns `204` and refresh says wrong app gives `401 invalid_grant`. | Contradiction. It decides whether a misconfigured origin looks like "session expired" to a client. |
| OQ-7 | **Status of the invalid-credentials error on change password** is unspecified. If it is `401`, it is indistinguishable from an expired access token, and a client that refreshes on `401` could loop. | Apps need to tell "wrong current password" from "token expired". |
| OQ-8 | **Change password while the account is blocked or locked.** The spec says a wrong current password counts as a failed login but does not say what a correct password returns during a block. | UX and enumeration behaviour are undefined. |
| OQ-9 | **No limits on refresh, logout, confirm and `/me`.** The abuse spec limits only login, signup, resend, forgot and reset. Confirm and refresh are token-guessing surfaces. | Apps should not assume a `429` is possible there. |
| OQ-10 | **Cross-check of email URL origins.** Confirm and reset calls come from the origin of `email_confirmation_url` and `password_reset_url`, but the registry does not require that origin to be in the app's allowed origins. | A misconfigured app has working emails and a broken confirm screen. |
| OQ-11 | **Exact `iss` value and JWKS URL for production.** The issuer is `AUTH_PUBLIC_BASE_URL`; whether it has a trailing slash and the production hostnames are not documented. | Backends need the exact string for `iss` checks. |
| OQ-12 | **Refresh response lost in transit.** With no grace window, a client that did not receive the response and retries is treated as a thief and loses the session. The spec accepts concurrency as reuse but does not discuss lost responses. | Documented as a client rule in the guide. Consider revisiting if the pilot sees false positives. |
| OQ-13 | **Unconfirmed accounts and forgot password.** No email is sent and the response is the generic `202`, so a user who never confirmed gets no feedback. | UI should offer both "resend confirmation" and "forgot password" generically. |
| OQ-14 | **Preflight headers.** The specs do not list allowed methods and headers or the max-age. The current middleware allows `GET, POST, OPTIONS` and echoes request headers. | Low. Apps should send only `Content-Type` and `Authorization`. |
| OQ-15 | **Numeric limit defaults** exist only in design (ADR 36), and `Retry-After` format (seconds) is only in design. | Apps should not hard-code them. |
| OQ-16 | **`README.md` is stale** (it describes hosted UI, no CORS on accounts, GET confirm and `AUTH_PUBLIC_BASE_URL` email links). | Developers reading the README get the old model. Not changed here. |
