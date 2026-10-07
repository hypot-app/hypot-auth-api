# Tasks: Auth Service MVP (Phase 1), API-only re-plan

Revision 2 (2026-10-05). U1-U6 are DONE and merged into `develop`; their entries below are condensed (full detail: git history and engram `sdd/auth-service/apply-progress`). The old U7-U10 are superseded. New units are U11-U19. Numbers U7-U10 are not reused, because discarded branches `u7a/u7b/u7c` and notes in engram still carry those names.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 6,850-7,860 (additions + deletions, excludes `package-lock.json`). Raw feature estimates multiplied by 3.75 (the proposal's 3.5-4x), tests included. Round 11 amendment added about 140-165 raw lines (about 525-620 changed lines): grace window, `refresh_ip` and `confirm_ip` limits, `/me` fields, change-password `400`, forgot for unconfirmed accounts, preflight headers, email URL origin rule (U11b note). The integration guide and API contract now ship from `docs/` ahead of U19d, which shrinks. |
| 400-line budget risk | Not applicable: the line budget was dropped (user decision 2026-10-07) |
| Chained PRs recommended | No |
| Suggested split | One PR per unit (U13 to U19), no line budget (user decision 2026-10-07). The a/b/c/d task groups below are an order of work inside the PR, not separate PRs. |
| Delivery strategy | One PR per unit, no line budget (user decision 2026-10-07; supersedes `ask-on-risk` resolved as chained PRs and every `size:exception` flag) |
| Chain strategy | None: every unit PR targets `develop` |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: none (one PR per unit)
400-line budget risk: not applicable (no line budget)

> No decision is pending. Delivery notes: one PR per unit, no line budget (user decision 2026-10-07). Do not split a unit for size and do not record `size:exception`. Keep commits as reviewable work units inside the PR (tests with the code, docs with the change they explain), and run a fresh verify before pushing. U13 was built as nine local branches (u13a to u13i) and ships as the single branch `feat/u13-abuse-protection` with that linear history plus the follow-ups of task group 13.22 to 13.27.

### Branch flow

```
develop: ... U6 -> U11a -> U11b -> U11c -> U12 -> U13 -> U14 -> U15 -> U16 -> U17 -> U18 -> U19
```

Every PR targets `develop`, never `main`. The next branch starts from the updated `develop` after the previous PR merges. If a diff shows earlier units, update from `develop` first (rebase if unpublished, merge `develop` in if published).

### Suggested Work Units

| Unit | Goal | Est. lines (3.5-4x) | Depends on | Task groups (one PR per unit, no line budget) |
|------|------|--------------------:|------------|--------------------------|
| U11 | Config https rule, app email URLs (`AppUrl`), CORS origin binding | about 920-1,030 (a: 541 actual) | U6 | a config + `AppUrl` + migration (actual 541, `size:exception`: removing the old post-reset code was pulled forward from b) / b use cases + CLI (about 150-190 after the pull-forward) / c origin binding + CORS routes (230-260) |
| U12 | transactional-email: links from app URLs with `#token` | 315-360 | U11 | single PR |
| U13 | abuse-protection: IP, config, counters, limiter, sweeper (all before bcrypt) | 930-1,060 | U12 | a domain + config + trust proxy (335-380, includes `refresh_ip` and `confirm_ip` scopes) / b table + store (280-320) / c guard + sweeper (315-360) |
| U14 | session-auth A: sessions, refresh-token storage, login | 955-1,085 | U13 | a migration + schemas (275-305, includes the grace columns) / b repository (300-340) / c login (385-440) |
| U15 | session-auth B: refresh rotation with reuse detection and grace window, logout, revoke-all | 875-1,005 | U14 | a refresh + `refresh_ip` + origin rule (320-360) / b reuse grace window (205-245) / c logout + revoke use case + `ops:revoke-all` (350-400) |
| U16 | `AuthenticateBearerUseCase` and `GET /api/v1/me` | 355-400 | U11, U14 | single PR |
| U17 | user-accounts: confirm becomes POST, CORS, limits, `unconfigured_client` | 615-690 | U12, U13 | a confirm POST (`200 {message}`) + origin binding + CORS + preflight headers + `confirm_ip` (330-370) / b limits + caps + unconfigured (285-320) |
| U18 | password-management: forgot, reset, change | 790-890 | U15, U16, U17 | a forgot incl. unconfirmed accounts (285-320) / b reset (245-280) / c change incl. `invalid_current_password` (260-290) |
| U19 | OpenAPI, retention job, e2e, integration guide status pass, ops, smoke test | 1,205-1,440 | all | a OpenAPI (245-280) / b retention (370-420) / c e2e + migration chain + grace journey (350-400) / d docs status pass, ops, issuer check (270-310) |

U11 row is not edited here (a parallel branch owns it). The U11b origin rule (11.4a) is now folded into U11b; the totals above already include it.

The units run sequentially: one writer. Each unit is one PR to `develop`; the a/b/c/d groups in the table are the order of work inside it. U11a to U11c were merged as separate PRs before the budget was dropped.

**Order change from the brief:** transactional-email (U12) moves before accounts, sessions and passwords. Reason: U17a removes `GET /accounts/confirm`, and every email queued after U5 still links to it; the fragment links must exist first. U12 only needs the app URLs from U11.

## Spec/Design reconciliation

The spec and design were written in parallel. Resolved (edited in the artifact that disagreed):

1. **HTTP 429 (spec wins).** Login never returns 429: limited, blocked and locked logins return the generic `401`. IP-only limits on signup, resend, forgot and reset return `429` + `Retry-After` and depend only on IP and endpoint group. Per-account email caps return the normal response and send nothing (signup still creates the account). Design ADR 36 rewritten; proposal success criterion reworded.
2. **Account-exists email (spec wins).** Links to the app's `password_reset_url` with no token and no fragment. ADR 39 and the design's closed-questions note fixed.
3. **Password change (design wins).** Revokes ALL sessions including the caller's. Password-management spec now says so.
4. **Refresh grace window (round 11, supersedes "no grace window").** About 10 s, same client IP, once per rotated token; the successor is revoked and a fresh pair is issued in the same session (ADR 35, U15b). Guidance lives in `docs/integration-guide.md`.
5. **Lockout numbers.** Pair 5 / 15 min, account 50 / 1 h, configurable. The proposal said about 10 and is fixed.
6. **Error codes.** Specs own status, codes and bodies. Design defers and lists the names the specs leave open. Refresh failure is `invalid_grant` (design had `invalid_refresh_token`).

Found and resolved by this re-plan:

7. **Bcrypt vs rate limits.** The session-auth spec said every attempt runs one bcrypt; the design (and the abuse spec) skip bcrypt for limited or blocked attempts. Design wins, because skipping the hash is the point of limiting and unknown emails are blocked identically. Session-auth spec amended.
8. **Unknown client on login.** Spec: generic `401`; design said `400 invalid_client`. Spec wins: it runs a dummy bcrypt and counts against the sentinel key `(unknown, IP)`, so random `client_id` values cannot bypass `login_ip` or grow the table. Other body endpoints keep `400 invalid_client`. App-registry spec and ADR 34/38 aligned.
9. **Confirm and reset bodies.** Specs take `{token}` and `{token, new_password}`; design had `client_id` too. Spec wins. Origin binding looks up the token's app first; a wrong origin or unknown token gives the same generic error (no oracle). ADR 38, 40 and the route table fixed.
10. **Trusted proxy name.** Spec `TRUSTED_PROXIES` vs design `TRUST_PROXY`. `TRUST_PROXY` wins; spec edited.
11. **Per-account email cap.** Spec 3/h, design 5/h. 3/h wins. A `reset_ip` scope (20/h) was added because the spec limits reset per IP too.
12. **Idle refresh TTL.** Design had 7 days idle plus 30 days absolute; spec only the 30 days. Compatible; spec gained the 7-day sentence.
13. **Migration timestamps** now follow merge order: abuse counters 5000, sessions 6000, retention indexes 7000. `revoked_reason` gained `ops_revoke_all`.
14. **Retention window** (the design only said "Phase 2 housekeeping"): defined in ADR 35. Sessions and one-time tokens one day after expiry, sent or failed outbox rows after 7 days, limiter rows by their own sweeper.

Round 11 amendment (binding user decisions plus orchestrator defaults, see ADR 35, 36, 38, 39, 43 and the specs):

15. **Change password, wrong current password:** `400 invalid_current_password` (not `401`), counts toward lockout; blocked gives the same `400`.
16. **Forgot for an unconfirmed account:** generic `202` and a confirmation email, counted in the per-account cap.
17. **Auth stores no profile:** `GET /me` returns `{ id, email, email_verified, created_at }`.
18. **Origin mismatch:** refresh gives `401 invalid_grant`; logout gives `204` with no effect (design had `400 invalid_client`).
19. **New per-IP limits:** `refresh_ip` 60 / 15 min and `confirm_ip` 20 / 1 h, `429` with an integer `Retry-After`; `/me` has none.
20. **Email URL origins** must be allowed origins of the app (app-registry spec; task 11.4a).
21. **Shared rules:** error body `{error, message}` everywhere, confirm `200 {message}`, fixed generic bodies, fixed preflight headers, `iss` = `AUTH_PUBLIC_BASE_URL` and JWKS = `${iss}/.well-known/jwks.json`.

Real forks: none. Items 8 and 9 are the closest; both follow the specs, and the orchestrator can revert 9 (add `client_id` to the confirm and reset bodies) at the cost of one extra field.

## Closed questions (round 3)

- argon2id vs bcrypt: bcrypt cost 12 (ADR 10). SendGrid vs SES: generic SMTP through Nodemailer (ADR 17).

## Done units (condensed)

- [x] U1 Bootstrap (welcome commit, TypeORM, migrations CLI, Jest + Testcontainers, `openspec/config.yaml` strict TDD) and U1b container setup (Dockerfile, `compose.yaml`)
- [x] U2 Platform: shared-kernel (Clock, TokenGenerator, Result, UnitOfWork), zod config, TypeORM module + UoW, `GET /health`, `api/v1` prefix via `configureApp` (ADR 28)
- [x] U3 app-registry: apps schema + migration, register/update/deactivate CLI, `AppUrl` predecessor (`PostResetRedirectUri`), origin allowlist CORS (ADR 29), review fixes 3.7, one-shot `migrate` compose service
- [x] U4 transactional-email: outbox with lease, worker, Nodemailer SMTP adapter, Handlebars renderer, five default templates (ADR 30)
- [x] U5 user-accounts: users + one_time_tokens, bcrypt hasher (8 chars, 72 bytes, no NUL), signup/confirm/resend (ADR 31), review fixes
- [x] U6 token-lifecycle A: key store (active/next/retired), RS256 `at+jwt` issuer and verifier with required audience, JWKS (ADR 32), review fixes 6.R1-6.R5

## Superseded units (do not implement)

- ~~U7 authorization-flow~~ Superseded by U13-U14: hosted login, PKCE and authorization codes are gone (ADR 34); never merged.
- ~~U8 token-lifecycle B~~ Superseded by U15: code exchange and `/oauth/*` are gone; refresh moves to session-auth (ADR 35).
- ~~U9 /me and password-management with hosted pages~~ Superseded by U16 and U18: JSON only, no pages, no redirect.
- ~~U10 verification and docs~~ Superseded by U19.

## Conventions for every task below

- Strict TDD: RED (a failing test, failing on its own assertion), GREEN (smallest change), REFACTOR (clean up with tests green). Commit by work unit with conventional commits, tests with the code.
- **Mutation check** on every security guard: temporarily break the guard, confirm a named test fails, restore. Record each in apply-progress.
- Every endpoint unit adds its own e2e on the shared `createTestApp` factory, with low `ABUSE_*` thresholds via config override and the fake `EmailSender`.
- Domain and application layers import no Nest, TypeORM, pg, jose or bcrypt. Migrations implement `down()` with an up, down, up test.
- Never read or edit `.env*`. The `.env.example` lines are documented for the user (task 19.11).

## U11 Config, app registry URLs, CORS binding

**U11a** `feat/u11a-config-app-urls` (541 lines actual, `size:exception`; forecast was 260-300)

- [x] 11.1 RED: `app-config.spec.ts` cases: `NODE_ENV=production` + `http://` `AUTH_PUBLIC_BASE_URL` throws `ConfigError` naming the variable; production + `https://` passes; development + `http://` passes. GREEN: case-sensitive `https://` prefix refine in `src/platform/config/app-config.ts`. Mutation: remove the refine, the production case fails. Add a README production note. (Also: compose `api` sets `NODE_ENV=development`, because the image defaults to production.)
- [x] 11.2 RED/GREEN/REFACTOR: `git mv` `PostResetRedirectUri` to `AppUrl` (`src/app-registry/domain/app-url.ts`) with the same table-driven rules (https, localhost http outside production, no userinfo, no fragment, relative/`javascript:`/`ftp:` rejected). Tests move with it and stay green. (Pulled in from U11b because the VO and column go away here: the `PostResetRedirectUri` use-case inputs, the CLI flags `--post-reset-redirect-uri` and `--clear-post-reset-redirect-uri`, their tests and README mentions are removed in U11a; U11b adds the new inputs.)
- [x] 11.3 RED: migration `1760000004000-AppEmailLinkUrls` int test: up adds nullable `email_confirmation_url` and `password_reset_url` and drops `post_reset_redirect_uri`; down restores it and drops both; up, down, up. Fix the `CreateApps` reversibility test for the new head. GREEN: migration, `AppRow`, `AppSchema`, `AppMapper` and domain `App` (`string | null`, round-trip including null).

**U11b** `feat/u11b-app-url-cli` (about 435 changed lines after trimming duplicate tests, slightly over the 400 budget so record `size:exception`; the removal of the post-reset use-case inputs, CLI flags, tests and README mentions already landed in U11a; includes 11.4a, folded in from the round 11 amendment)

- [x] 11.4 RED/GREEN: register requires both URLs validated through `AppUrl` (`isProduction` from config); update replaces but rejects clear or blank; invalid input persists nothing. Mutation: skip validation on update, the clear/blank test fails.
- [x] 11.5 RED/GREEN/REFACTOR: CLI `--email-confirmation-url` and `--password-reset-url` (required on create, optional on update). Assert that an unknown option such as `--post-reset-redirect-uri` exits non-zero, and assert the specific `CliError` messages. Re-add the CLI test that `NODE_ENV=production` rejects `http://localhost` for both URLs (verify S1, dropped with the old post-reset tests in U11a). REFACTOR shared option parsing. (Flag and use-case removal already done in 11.2.)
- [x] 11.6 Docs: README `app create` / `app update` examples with both new flags (the `--post-reset-redirect-uri` mentions are already gone), a note that existing dev apps need one `app update` with both URLs before signup or forgot works.

- [x] 11.4a RED/GREEN: email URL origin rule (app-registry spec, ADR 39). The origin of `email_confirmation_url` and `password_reset_url` must be one of the app's `allowed_origins` (compared after the `AllowedOrigin` normalization via `URL.origin`). Enforced as an `App` invariant (`email_url_origin_not_allowed`) in `App.create`, and `App.update` rebuilds through it, so it holds on create and on update, including an update that removes an origin a stored URL uses. Errors name the field and the origin, and nothing is persisted. `AppUrl.create` takes an optional label so errors name the field (`Invalid email_confirmation_url: ...`). Legacy apps with null URLs skip the rule. An app needs at least one allowed origin: create without `--origin` fails with `at least one --origin is required`. Mutation: skip the check on update, the orphaned-origins test fails. CLI messages asserted as in 11.5.

**U11c** `feat/u11c-origin-binding` (230-260 lines)

- [x] 11.7 RED: `ResolveClientUseCase.execute(clientId, { origin })` unit: no origin passes; the app's own origin passes; another active app's origin gives `invalid_client`; inactive or unknown gives `invalid_client`; comparison is exact (case, trailing slash). GREEN. Mutation: check "any active app" instead of the app's own origins, the wrong-app case fails.
- [x] 11.8 RED/GREEN: `AppCorsMiddleware` route list becomes the 10 API routes of ADR 38; preflight answers for any active app (204); never `Access-Control-Allow-Credentials`, never a wildcard; the 30 s cache stays. e2e on a test-only route group proves preflight, allow header and no credentials header. Each later endpoint unit adds its own wrong-origin e2e.

  As built: the input is the object form `ResolveClientUseCase.execute({ clientId, origin? })` (not a positional argument); the mismatch error is the same `invalid_client` as unknown or inactive, with the same message. The preflight already answers with the fixed header set of ADR 38 (moved here from 17.3). The e2e probes use `auth/login` and `me`, and every one of the 10 routes is preflight-tested. `accounts/signup` and `accounts/resend-confirmation` are wired end to end: the controller reads the `Origin` header, passes it as `origin` through `SignupUseCase` and `ResendConfirmationUseCase`, and grants `Access-Control-Allow-Origin` (through the `@CorsGrant()` decorator of `platform/http/cors-grant`) only when the binding passed or the 400 is a request-validation error; on `invalid_client` it does not grant, so the browser gets no allow header.

  **How later units plug in.** CORS is fail-closed: the middleware answers preflights and, on actual requests, only sets `Vary: Origin` and stashes the candidate origin. An endpoint grants `Access-Control-Allow-Origin` by calling the `@CorsGrant()` function (import from `platform/http/cors-grant`), and only AFTER its binding passes; forgetting to call it gives a visible CORS failure, not a leak. Request-validation 400 answers also call it, so the SPA can read them. The rate limiter's `429` and `503` need no call: `AbuseExceptionFilter` grants them itself (U13e). The ADR 38 per-endpoint outcomes still apply: (1) Body endpoints with `client_id` (login, refresh, logout, forgot): read `@Headers('origin')`, pass `origin` to `ResolveClientUseCase`, then on a binding failure map to that endpoint's own outcome (login generic `401`, refresh `401 invalid_grant` with the token unconsumed, logout `204` with no effect, forgot `400 invalid_client`) WITHOUT granting, including the logout `204`. (2) Token-in-body endpoints (confirm POST, reset): find the token's app read-only, then resolve it with `origin`; the failure is the generic `invalid_or_expired_link`, not granted. (3) Bearer endpoints (`/me`, change): after verifying with the `aud` app, resolve that app with `origin` and answer the generic `401`, not granted. Requests with no `Origin` header pass `origin: undefined` and skip the binding. Known gap until U17a: `GET accounts/confirm` (token in the query) has no binding and therefore no grant yet, so a browser `fetch` of it is not readable cross-origin (email links are navigations and are unaffected).

## U12 Transactional-email app links

**U12** `feat/u12-email-app-links` (315-360 lines)

- [x] 12.1 RED: `EmailLinks` unit: confirmation link `https://a.example/confirm#token=<percent-encoded>`; reset link likewise; a null URL throws `UnconfiguredLink`; no output contains `AUTH_PUBLIC_BASE_URL`. GREEN: rewrite `src/transactional-email/application/email-links.ts` from the app record.
- [x] 12.2 RED/GREEN: `OutboxWorker` builds links at send time from the current app (`findById`); a null URL marks the row `failed` at once with the payload purged and no token in logs. Update existing worker tests.
- [x] 12.3 RED/GREEN: templates `confirmation`, `reset` use the built link; `account-exists` links to `password_reset_url` with no token and no `#`; `welcome` and `password-changed` unchanged. Renderer tests: no password, no `AUTH_PUBLIC_BASE_URL` anywhere, `account-exists` has no token.
- [x] 12.4 RED/GREEN: update `email-pipeline.int-spec` (Mailpit): the delivered mail carries `app URL + #token=`. Mutation: build from `AUTH_PUBLIC_BASE_URL`, the pipeline and link tests fail. Update the README TTL TODO and ADR 30 payload note if they mention link bases.

## U13 Abuse protection (all of it lands before any bcrypt path)

**U13a** `feat/u13a-abuse-domain-config` (398 lines actual; the forecast was 315-360)

- [x] 13.1 RED/GREEN: `ClientIp` value object (`src/abuse-protection/domain/`): IPv4-mapped IPv6 becomes IPv4; IPv6 keyed on its /64; undefined or malformed falls back to the socket peer. Table-driven.
- [x] 13.2 RED/GREEN: `Scope`, `Policy` table and `CounterKey` (SHA-256 of scope + normalized parts, scopes cannot collide): defaults `login_ip` 100/15 min, `login_account_ip` 5/15 min block 15 min, `login_account` 50/1 h block 15 min, `email_ip` 20/1 h, `reset_ip` 20/1 h (keyed by IP only), `confirm_ip` 20/1 h (IP only), `refresh_ip` 60/15 min (client + IP), `email_account` 3/1 h. Tests for defaults and env override, and that `reset_ip`, `confirm_ip` and `refresh_ip` keys cannot collide for the same IP.
- [x] 13.3 RED/GREEN: zod config `TRUST_PROXY` (`false` default, hop count, or CIDR/Express names; `true` rejected at boot) and `ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS`, `_BLOCK_SECONDS` (positive integers).
- [x] 13.4 RED/GREEN: `configureApp` sets Express `trust proxy` from config. e2e with a test-only echo route: spoofed `X-Forwarded-For` ignored when `false`; behind a trusted proxy the client is the first untrusted address from the right; malformed falls back to the peer. Mutation: `trust proxy = true`, the spoof test fails.

**U13b** `feat/u13b-abuse-store` (280-320 lines)

- [x] 13.5 RED: migration `1760000005000-CreateAbuseCounters` int test: table is `UNLOGGED` (`relpersistence = 'u'`), PK `(scope, key)`, index on `expires_at`; up, down, up. GREEN: migration, `EntitySchema`, `AbuseCounterStore` port.
- [x] 13.6 RED/GREEN: `PostgresAbuseCounterStore.hit` as the single atomic upsert of ADR 36 with the injected `Clock`: window rollover, threshold sets `blocked_until`, hits during a block do not extend it. Always uses the root `DataSource` manager. Int tests with a fixed clock; 10 parallel hits read count 10 and set `blocked_until` once; a rolled-back UoW leaves the count. Mutations: use the ALS manager, the rollback test fails; read-then-write instead of upsert, the concurrency test fails.
- [x] 13.7 RED/GREEN: `blockedUntil(keys, now)` and `reset(scope, key)`; tests include an expired block and reset of a missing key. (`blockedUntil` was removed in U13g: the login pre-count made it dead code.)

**U13c** `feat/u13c-abuse-guard` (339 lines, 13.8 and 13.9; split from the planned guard-plus-sweeper branch, which measured about 700)

- [x] 13.8 RED/GREEN: `AbuseGuard` (application) with port fakes and a fixed clock, covering the spec scenarios: pair block while IP Y still passes, global lock, lock expiry, unknown email identical, threshold 3 configurable, success resets the pair counter and not the global one, attempts during a block do not extend it. Mutation: reset the global counter on success, the global-lock test fails.
- [x] 13.9 RED/GREEN: decisions `allowed`, `ip_limited(retryAfterSeconds)` and `account_suppressed` for the email, reset, confirm and refresh checks (`retryAfterSeconds` is an integer, at least 1). Store failure raises `TemporarilyUnavailable` (mapped to `503 temporarily_unavailable`) before any account lookup. Mutation: fail open, the 503 test fails.

**U13d** `feat/u13d-abuse-sweeper-module` (13.10 plus the `429`/`503` filter and wiring tests)

- [x] 13.10 RED/GREEN: `AbuseCounterSweeper` deletes expired rows every 5 min in batches of 1,000, started by `main.ts` only (outbox-poller pattern), awaits its drain on shutdown; `AbuseProtectionModule` exports the guard. Int test: expired rows deleted, live rows kept, batch loop. Check with `rg` the dependency direction (corrected in U13h; the original "imports only `shared-kernel`" note was wrong): `rg -n "abuse-protection" src/platform -g '!*.spec.ts'` prints nothing, so `platform` does not import `abuse-protection`. Outside itself `abuse-protection` imports `shared-kernel` and `platform/http/cors-grant` (the CORS grant of the `429`/`503` filter, U13e; moved from `app-registry/http` in the U13 follow-up, so no feature depends on a sibling's http helper). Only the composition root `app.module.ts` imports `AbuseProtectionModule`.

**U13e** `feat/u13e-abuse-guard-hardening` (review fixes W3 and W2 of the U13 verify; stacked on U13d)

- [x] 13.11 RED/GREEN (W3): `AbuseExceptionFilter` grants CORS on both `429` and `503`. e2e: a `429` thrown without a controller grant is readable from an active app's origin; a `503` has the allow header; no `Origin` or an unknown origin gets none. Unit rows for both statuses. Mutations: no grant (2 e2e fail), grant only the 429 (1).
- [x] 13.12 RED/GREEN (W2): a limiter outage logs `abuse limiter store unavailable (<scope>): <driver message>` (no keys, IPs or parameters; a non-Error cause prints `unknown error`), at most once per 60 s per process with the injected `Clock`; `TemporarilyUnavailable` carries the `scope`. Mutations: no throttle, `<=` at the boundary, log the 429, print the raw cause, drop the scope.

**U13f** `feat/u13f-abuse-client-ref` (review fix W4 of the U13 verify; stacked on U13e)

- [x] 13.13 RED/GREEN (W4): structural invariants. `checkLoginIp(client, ip): Promise<boolean>` is the only login IP check; `checkIp` and `checkClientIp` take separate scope unions without `login_ip`, so login has no path to a Retry-After or a `429`. The guard accepts only a branded `ClientRef` (`ClientRef.resolved(id)` for a resolved active app, `ClientRef.unknown()` for the sentinel, whose key cannot collide with an app whose id is `unknown`), never a raw string; `UNKNOWN_CLIENT_ID` is gone. `@ts-expect-error` specs make `npm run typecheck` fail if either restriction is loosened. Mutations: widen `checkClientIp` back to `login_ip` and drop the `ClientRef` brand (each makes `tsc` report an unused directive); resolved key without its prefix (1 fails); a random sentinel key (1).

**U13g** `feat/u13g-login-pre-count` (review fix W1 of the U13 verify; stacked on U13f)

- [x] 13.14 RED/GREEN (W1): the login lockout counts BEFORE bcrypt. `AbuseGuard.beginLoginAttempt(client, email, ip): 'allowed' | 'blocked'` hits the pair counter, then the global counter unless the pair is already blocked, one atomic upsert each; exactly `limit` attempts pass, and a block older than the hit (it survives a window rollover) or a re-lock inside the same window blocks. `recordLoginSuccess` refunds the pair only; the global counter is not decremented (assumption in ADR 36 and the spec: it counts attempts, and a decrement would reopen the race). `isLoginBlocked`, `recordLoginFailure` and the store's `blockedUntil` are removed. Tests: 12 parallel attempts on one pair give exactly 5 allowed (unit and on the real table), 60 parallel from many IPs give exactly 50, blocked pair attempts do not charge the account. Mutations: non-atomic hit in the fake (2 fail), allow an older lock (1), tripping hit blocked (5), `>=` (5), global hit while the pair is blocked (1), reset the global counter (1), fail open (6).

**U13h** `feat/u13h-abuse-config-ownership` (review fix W5 of the U13 verify; stacked on U13g)

- [x] 13.16 RED/GREEN (W5): `ABUSE_<SCOPE>_*` parsing moves out of `platform/config` into `abuse-protection/infrastructure/abuse-config.ts` (`loadAbusePolicies(env)`, `AbuseConfigError`). `AbuseProtectionModule` provides `ABUSE_POLICIES` from a raw-env provider (`ABUSE_ENV`, the `SIGNING_KEYS_SOURCE` pattern of `token-lifecycle`), parsed at boot so a bad value stops the app. `AppConfig` loses `abusePolicies`; `TRUST_PROXY` stays in platform because `configureApp` needs it. The existing config tests move with the code; new tests: boot fails on a bad value, a block length is ignored for scopes without a lockout, the platform no longer parses `ABUSE_*`. Mutations: ignore the env (3 fail), never throw (6), provider ignores the env (2), accept a block length for every scope (1).

**U13i** `feat/u13i-abuse-s-items` (suggestions S1, S2, S3, S5, S8 of the U13 verify; stacked on U13h)

- [x] 13.17 RED/GREEN (S5, found a real gap): a direct test that the global lock expires after 15 min. It failed: after a lock ended inside its 1 h window the count stayed above the limit, so the pre-count kept blocking until the window ended. A window now also rolls when a lockout inside it ends (SQL `ROLLED` in `PostgresAbuseCounterStore` and the fake), so the lock lifts and counting restarts. The old int test "blocks again after an expired block" is replaced by the restart case. ADR 36 documents it (this also settles S6).
- [x] 13.18 RED/GREEN (S2): one contract suite (`abuse-counter-store.contract.int-spec.ts`) runs the same rules against `InMemoryAbuseCounterStore` and `PostgresAbuseCounterStore`: window anchor and exact rollover, block at the limit, no extension, block kept across a rollover, restart after a block expires, limit 1, reset and key isolation. Mutations: fake without the restart (1 fails), fake extends a block (2), Postgres `<` instead of `<=` on the block end (1).
- [x] 13.19 RED/GREEN (S1): `AbuseCounterSweeper.start()` sweeps once at once, then every 5 min (fake timers). Mutation: no immediate sweep (3 fail).
- [x] 13.20 RED/GREEN (S8): every `ABUSE_*_LIMIT`, `_WINDOW_SECONDS` and `_BLOCK_SECONDS` is capped at 2147483647 (`int4`, the type the store binds). Documented choice: the int4 maximum rather than a lower operational cap, because any lower number would be arbitrary and the purpose is only to fail at boot instead of 503 on every hit. Mutation: `<` instead of `<=` (3 fail).
- [x] 13.21 RED/GREEN (S3): `TRUST_PROXY` hop count capped at 10, CIDR prefix floor /8 (IPv4) and /16 (IPv6). ADR 37 no longer claims every mistake fails safe: an overstated hop count or a broad CIDR lets the leftmost client-controlled `X-Forwarded-For` value win (operator misconfiguration risk). Mutations: cap 9 and 11, floors 7 and 9 (IPv4), 15 and 17 (IPv6), each fails a test.

**Follow-ups of the second U13 verify** (`sdd/auth-service/verify-report`; same branch `feat/u13-abuse-protection`, new commits on top of u13i; the line budget no longer applies)

- [x] 13.22 DOCS (W1, user decision A: document the real throughput, no behaviour change): README, the abuse-protection spec, `docs/api-contract.md` and ADR 36 now say that the global account limit is 50 attempts per window, that reaching it locks the account for 15 min and that the count restarts when the lock ends, so a distributed attacker gets at most about 200 attempts per hour per account (at least 10 distinct IPs needed, because each account and IP pair is capped at about 20 per hour; 25 in a closed hour with bursts). Password change (U19) shares both counters. `docs/integration-guide.md` tells app teams that a service account or automation that logs in more than 50 times an hour locks itself, and that they must reuse refresh tokens.
- [x] 13.23 RED/GREEN (W2): `ClientRef.resolved(app: App)` takes the resolved `App` (type-only import, nominal through its private member `snapshot()`; a private constructor alone would not make it nominal) instead of a string. Chosen over a branded `AppId` because it adds no new type and no runtime coupling, and over a `ResolvedClient` minted by `ResolveClientUseCase` for the same reason. `@ts-expect-error` specs prove `ClientRef.resolved('raw-string')`, `ClientRef.resolved(body.client_id)` and a look-alike object do not compile. Mutation: widen to `App | string`, two directives become unused and `npm run typecheck` fails. Callers and tests use the new `anApp()` fixture (`test/support/app-fixture.ts`). Residual: `App.restore` is public, so code that builds a whole `App` by hand can still mint a ref; U14 task 14.0 keeps the e2e that random `client_id` values share one limit.
- [x] 13.24 RED/GREEN: explicit "locked before this hit" signal. `HitResult.blockedBefore` is computed in SQL from the PREVIOUS row (`blocked_until > now`, a `FOR UPDATE` CTE feeding the upsert), and `AbuseGuard` blocks on `count > limit || blockedBefore`. The JS test `blockedUntil != now + blockSeconds` is removed. `InMemoryAbuseCounterStore` and the contract suite agree on it (2 new contract rules, 2 stores). Guard tests use a scripted store so only the flag can steer the result. Mutations: flag always false in SQL (3 fail), `>=` instead of `>` (2), guard ignores the flag (2), fake always false (3).
- [x] 13.25 TEST (S-a): on real Postgres, 30 parallel `beginLoginAttempt` calls with an advancing clock (a distinct `now` each) allow exactly 5, and a trip-then-window-roll case through the guard (blocked inside the lock after the window rolled, allowed at the exact lock end). Mutations: guard ignores the flag (the roll test fails), `>=` (3 fail). Removing `FOR UPDATE` from the CTE is NOT caught by a deterministic test (recorded as a residual risk).
- [x] 13.26 REFACTOR (S-b): `cors-grant.ts` moves from `app-registry/http` to `platform/http`; every import is updated (`app-cors.middleware`, `accounts.controller`, `abuse-exception.filter`, the CORS e2e) and `rg -n "app-registry/http/cors-grant" src test docs openspec README.md` prints nothing.
- [x] 13.27 DOCS (S-d): the ADR 36 SQL snippet shows the real statement (the `prev` and `gate` CTEs, the `ROLLED` condition, the `RETURNING` columns and `blocked_before`).

## U14 Session-auth A: sessions and login

> **U13f/U13g contract for login.** Login MUST use `AbuseGuard.checkLoginIp`, `AbuseGuard.beginLoginAttempt` and `ClientRef` (never a raw `client_id` string, never `checkClientIp`). The `401` for a limited, blocked or locked login is the generic one; there is no 429 path by construction. `POST /password/change` (U19) uses `beginLoginAttempt` and `recordLoginSuccess` as well.

- [x] 14.0 RED (first task of U14): an e2e probe (the pattern of `abuse-protection.e2e-spec.ts`) that resolves the client for each request and calls `checkLoginIp` with `ClientRef.resolved` for a known app and `ClientRef.unknown()` otherwise. Many requests with different random `client_id` values from one IP share ONE `login_ip` limit and cannot grow the table without bound. 14.7 repeats the assertion against the real endpoint.

**Group 1: session persistence**

- [x] 14.1 RED: migration `1760000006000-CreateAuthSessions` int test: `auth_sessions` (`revoked_reason` enum including `ops_revoke_all`, indexes on `user_id` and `expires_at`) and `refresh_tokens` (`token_hash bytea` PK, `session_id` FK indexed, plus the grace-window columns `replaced_by_hash bytea NULL`, `consumed_ip_hash bytea NULL`, `grace_used_at NULL`, `revoked_at NULL`, ADR 35); up, down (drops the enum), up. GREEN.
- [x] 14.2 RED/GREEN: domain `Session` and `RefreshToken`, `EntitySchema` rows, mappers with round-trip tests (null `revoked_at`, `consumed_at`, `replaced_by_hash`, `consumed_ip_hash` and `grace_used_at`, every enum value). Hexagonal check on imports.

**Group 2: session repository**

- [ ] 14.3 RED/GREEN: `SessionRepository.open(session, firstTokenHash)` and `consume(hash, appId, now, successorHash, ipHash)` as the single `UPDATE .. FROM auth_sessions .. RETURNING` of ADR 35, storing `replaced_by_hash` and `consumed_ip_hash`. Int tests: wrong app, idle expiry, absolute expiry, revoked session and a token with `revoked_at` each return null; N parallel consumes yield exactly one winner. Mutations: drop `consumed_at IS NULL`, the replay and concurrency tests fail; drop the `app_id` join, the wrong-app test fails; drop `revoked_at IS NULL`, the revoked-token test fails.
- [ ] 14.4 RED/GREEN: `findTokenState` (including consumed time, IP hash, grace-used and revoked flags), `revoke(sessionId, reason)` (idempotent, keeps the first reason), `revokeAllForUser(userId, reason)`, `claimGrace(hash, now)` (returns `replaced_by_hash` once, null on the second call, concurrent claims yield one winner), `revokeToken(hash, now)` (false when the token was already used or revoked) and `addToken`. Int tests include other users untouched.

**Group 3: login**

- [ ] 14.5 RED: `LoginUseCase` unit with recording fakes. Exactly one `verify` on each path (unknown email, wrong password, unconfirmed, success, unknown client, malformed email, password bcrypt cannot hash compared as `''`); zero `verify` when limited or blocked; `beginLoginAttempt` called once per attempt BEFORE the lookup and before `verify`, including unknown emails (blocked: zero `verify`); success calls `recordLoginSuccess` (pair only); an unknown client uses `ClientRef.unknown()`. Mutations: return early for an unknown email, skip the dummy hash, skip the confirmed check, count after `verify`. The U7 ordering is a reference, not cherry-picked.
- [ ] 14.6 GREEN: `LoginUseCase`, boot-time dummy cost-12 hash provider, session issue in one `UnitOfWork` (open session + first token, then sign the access token with `aud` = `client_id`, `sub` = user id). Config `REFRESH_IDLE_TTL_SECONDS` (604800) and `REFRESH_ABSOLUTE_TTL_SECONDS` (2592000).
- [ ] 14.7 RED/GREEN: `POST /api/v1/auth/login` (zod body, `req.ip`, `Origin` passed to the use case). e2e: 200 body shape, `expires_in` 3600, `aud`, no `Set-Cookie`; byte-identical `401` (status, body, headers) for unknown email, wrong password, unconfirmed, locked, blocked, IP-limited and unknown client, and never `429`; correct password on an unconfirmed, locked or blocked account issues nothing; malformed body gives `400 invalid_request` without state wording; wrong-app origin gives the generic `401`; no `Origin` skips the binding; allow header bound to the app, no credentials header.

## U15 Session-auth B: refresh and logout

**Group 1: refresh rotation.** The grace window is NOT in this group: here every reuse revokes the session.

- [ ] 15.1 RED/GREEN: `RefreshSessionUseCase`: consume (with the successor hash and the `ClientIp` hash), successor and `last_used_at` in one UoW. Wrong app, unknown and expired give an identical `401 invalid_grant`. A consumed or revoked token of the same app revokes its session (`reuse_detected`); a consumed token of another app revokes nothing. Mutations: revoke on a wrong-app token, skip revoke on reuse; both fail a named test.
- [ ] 15.2 RED/GREEN: int concurrency: N parallel refreshes of one token give one success, and the session ends revoked including the winner's successor. Replay of R1 after R1 to R2 to R3 revokes R2 and R3. Rotation does not extend the absolute expiry; the idle expiry caps at the session expiry.
- [ ] 15.3 RED/GREEN: `POST /api/v1/auth/refresh` and e2e: same body shape as login, DB rows hold only hashes, malformed body gives `400 invalid_request`, unknown or inactive client gives `400 invalid_client`, an `Origin` not bound to `client_id` gives the same `401 invalid_grant` as an unknown token with no allow header and the token unconsumed (mutation: check the origin after the consume, the token-unconsumed test fails), allow headers bound to the app.
- [ ] 15.3a RED/GREEN: `refresh_ip` (`AbuseGuard`, before any token lookup): an over-limit IP gets `429 rate_limited` with an integer `Retry-After`, identical for a valid and an invalid token, with no token consumed; the limit is configurable. Mutation: run the check after the lookup, the no-lookup assertion fails.

**Group 2: refresh grace window.** Strict TDD, one RED test per scenario of the session-auth spec, every guard mutation-checked.

- [ ] 15.7 Config: `REFRESH_REUSE_GRACE_SECONDS` (zod, non-negative integer, default 10, `0` disables) with tests for the default, an override and a negative value rejected.
- [ ] 15.8 RED: `RefreshSessionUseCase` unit with an injected `Clock`, fakes and a fixed `ClientIp`, one test each: (a) reuse of R1 inside the window from the same IP returns 200 with a pair R3, R2 revoked, session NOT revoked, R3 is not R2; (b) inside the window from a different IP revokes the session; (c) after the window revokes the session; (d) a second reuse of R1 inside the window revokes the session; (e) R2 already used (R1 to R2 to R3) then R1 inside the window revokes the session; (f) grace `0` revokes; (g) a revoked successor R2 presented later revokes the session; (h) IPv6 addresses in the same /64 count as the same IP; (i) a token with `revoked_at` never takes the grace path. GREEN: the grace branch of ADR 35 (`claimGrace`, `revokeToken`, `addToken`, fresh access token, one UoW; revoke the session on any zero-row step). REFACTOR: extract the eligibility decision into a pure domain function with its own table-driven test.
- [ ] 15.9 Mutations (each must fail a named test, then restore): drop the same-IP check, (b) fails; drop the window check, (c) fails; skip `grace_used_at` (allow a second grace), (d) fails; skip the successor revoke, (a) and (g) fail; skip the successor-unused check, (e) fails; return the old successor instead of a fresh token, (a) fails. Record each in apply-progress.
- [ ] 15.10 RED/GREEN: int tests on real Postgres: N parallel presentations of one rotated token inside the window from one IP give exactly one grace success and the session ends revoked on the next concurrent reuse; a rolled-back grace UoW leaves `grace_used_at` unset; the table holds hashes only after a grace reuse (no raw token recoverable). e2e: lost-response retry (rotate, ignore the response, retry the old token from the same IP) returns 200 and keeps the session; the same retry after advancing the clock past the window logs out.

**Group 3: logout and revoke-all**

- [ ] 15.4 RED/GREEN: `LogoutUseCase` and `POST /api/v1/auth/logout`: `204` for active, revoked, expired, unknown and other-app tokens; revokes only when the token belongs to the client's app AND any `Origin` is bound to that app (an unbound origin still gets `204`, revokes nothing and gets no allow header); a malformed body gives `400 invalid_request`; a later refresh fails; an issued access token still verifies until `exp`. Mutation: ignore the origin binding, the unbound-origin test fails.
- [ ] 15.5 RED/GREEN: `RevokeAccountSessionsUseCase` (userId, reason) exported by `session-auth` for password-management; int test: all of that user's sessions revoked, other users untouched, reason stored.
- [ ] 15.6 RED/GREEN: CLI `ops:revoke-all` (nest-commander, requires `--yes`, prints the count, reason `ops_revoke_all`); the CLI boots without a signing key; e2e shows a refresh fails afterward. Mutation: omit the `--yes` guard, the guard test fails.

## U16 `/me`

**Bearer authentication and `/me`**

- [ ] 16.1 RED/GREEN: `AuthenticateBearerUseCase` (`token-lifecycle/application`, ADR 32): read `aud` from the unverified payload only to pick the expectation, require an active app through `ResolveClientUseCase`, then `verify(token, { audience })`, then bind the origin to that app. Unit: missing, expired, bad signature, `none`, HS256, no `aud`, unknown `aud`, inactive `aud`, wrong `typ`, wrong-app origin all give one identical `unauthorized`; no `Origin` passes. Mutations: skip the verify call, skip the active-app check.
- [ ] 16.2 RED/GREEN: `GET /api/v1/me`: exactly `{ id, email, email_verified, created_at }` of that account only (`id` equals `sub`, `email_verified` boolean from `email_verified_at`, `created_at` ISO 8601 UTC), read through `UserRepository.findById` scoped to the token's app (add if missing). Auth stores no name or profile, and a test asserts the response has no other keys. Unknown user is `401`. e2e: no password hash or internal fields, `401 { error: "invalid_token", message }` with `WWW-Authenticate: Bearer`, byte-identical for every cause, allow header bound to the token's `aud`, app B origin gets none. There is no limiter on `/me`: a test documents that many calls stay `200` and the guard is not called. Mutation: add `name` or `password_hash` to the mapper output, the exact-keys test fails.

## U17 User-accounts changes

**Group 1: confirm POST and CORS**

- [ ] 17.1 RED/GREEN: `GET /api/v1/accounts/confirm` returns `404` and leaves the token unused; `POST /api/v1/accounts/confirm {token}` confirms, queues `welcome`, returns `200 { "message": "Your email address has been confirmed." }` with no tokens issued, and every failure (malformed, unknown, used, expired, wrong purpose) gives an identical `400 invalid_or_expired_link`; a missing `token` field gives `400 invalid_request`. Remove the GET controller.
- [ ] 17.1a RED/GREEN: `confirm_ip` limit through `AbuseGuard`, before any token lookup: over the limit gives `429 rate_limited` with an integer `Retry-After`, identical for a valid and an invalid token, token untouched. Mutation: run the check after the lookup, the no-lookup assertion fails.
- [ ] 17.2 RED/GREEN: `OneTimeTokenRepository.findAppByTokenHash` (read-only). The origin is bound to the token's app before the consume; a wrong origin or unknown token gives the same generic error and the token stays unused; no `Origin` passes. Mutation: consume before binding, the token-stays-unused test fails.
- [ ] 17.3 RED/GREEN: CORS on `accounts/signup`, `accounts/confirm`, `accounts/resend-confirmation`: preflight, own-origin allow header, other-app origin rejected with `400 invalid_client` and no allow header. Also complete the preflight header set in `AppCorsMiddleware` (route list stays with 11.8): `204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization` (fixed, not echoed: a request asking for `X-Custom` still gets the fixed list), `Access-Control-Max-Age: 600`, `Vary: Origin` on preflight and actual responses, never `Access-Control-Allow-Credentials`. Mutation: echo the requested headers, the fixed-list test fails. Replace the "no CORS on accounts" note in README and ADR 31 (already marked superseded).

**Group 2: limits, caps and unconfigured clients**

- [ ] 17.4 RED/GREEN: signup and resend call `AbuseGuard` first, before bcrypt and any lookup. IP-limited gives `429 rate_limited` with `Retry-After`, identical for a new and an existing email, and runs no hash. A per-account cap gives the normal `202`; signup still creates the account but queues nothing; resend queues nothing. Store failure gives `503` before any lookup. Mutation: make the `429` depend on account existence, the equality test fails.
- [ ] 17.5 RED/GREEN: an app with a null `email_confirmation_url` OR a null `password_reset_url` gives `400 unconfigured_client` on signup and resend before any account work (no rows, no outbox, no hash). Both are checked because signup for an existing email sends the account-exists mail, which links to `password_reset_url` (12.3). Scenario: app with only `email_confirmation_url` set (legacy app half-updated) gets `unconfigured_client` on signup and resend, and the reverse case (only `password_reset_url`) does too.
- [ ] 17.6 RED/GREEN e2e: new, duplicate and capped signups are indistinguishable (the fixed `message` texts of signup and resend are asserted byte for byte, and every error body has string `error` and `message`); remove the "resend gap accepted until Phase 2" wording from ADR 31 and README, since the limits now bound it.

## U18 Password management

**Group 1: forgot**

- [ ] 18.1 RED/GREEN: `ForgotPasswordUseCase` order: client (`invalid_client`, or `unconfigured_client` as `400` when EITHER `email_confirmation_url` OR `password_reset_url` is null, since the unconfirmed-account path sends a confirmation link and the confirmed path a reset link), `email_ip` (`429`), `email_account` (silent), then by account state, in one UoW: confirmed gives a 1 h token that supersedes earlier unused reset tokens plus a `reset` outbox row; UNCONFIRMED gives a new confirmation token that supersedes earlier unused confirmation tokens (reuse the resend code path) plus a `confirmation` outbox row, and never a reset token; unknown or other-app-only gives nothing. Always the fixed generic `202` body `{ "message": "If an account exists for this address, an email is on its way." }`. Unit with fakes.
- [ ] 18.2 RED/GREEN: `POST /api/v1/password/forgot` and e2e: confirmed, unconfirmed, unknown and other-app-only give byte-identical `202`; confirmed queues a `reset`, unconfirmed queues a `confirmation` (and no reset token exists for it), unknown queues nothing; the confirmation mail from forgot confirms the account through `POST /accounts/confirm`; `GET /api/v1/password/forgot` is `404`; a provider outage still gives `202`; emails from forgot for an unconfirmed account count toward the per-account cap (the 4th mail in an hour across signup, resend and forgot is suppressed); IP limit gives `429`; a malformed body gives `400 invalid_request`; CORS bound to `client_id`. Mutations: send a reset for an unconfirmed account; do not count the unconfirmed email toward the cap; both fail a named test.

**Group 2: reset**

- [ ] 18.3 RED/GREEN: `ResetPasswordUseCase {token, new_password}`: validate the password first (weak gives `400` and the token stays usable), `reset_ip` check, origin bound to the token's app (shared with 17.2), then one UoW: consume the token, write the hash and `password_changed_at`, `revokeAllForUser(password_reset)`. Used, expired (over 1 h), superseded and unknown give one generic error. Int tests: concurrent double submit has one winner; a revoke failure rolls back (hash unchanged, token unused). Mutations: revoke outside the UoW, ignore supersession.
- [ ] 18.4 RED/GREEN: `POST /api/v1/password/reset` e2e: `204`, no `Location`, hash is `$2b$12$`, `GET` is `404`, two sessions both die, `429` on IP limit, CORS bound through the token.

**Group 3: change**

- [ ] 18.5 RED/GREEN: `ChangePasswordUseCase` via `AuthenticateBearerUseCase`. Order: bearer, body shape (`400 invalid_request`), new-password rules (`400 invalid_password`, no counter touched), lockout state (blocked or locked gives `400 invalid_current_password` even for the correct password, with NO bcrypt), compare. A wrong current password gives `400 invalid_current_password` (never `401`) and records both counters; success resets the pair counter, writes the hash, `revokeAllForUser(password_changed)` and queues the `password-changed` notice, all in one UoW. Mutations: skip failure recording, exclude the caller's session from revocation, return `401` for a wrong current password (the status test fails), run bcrypt while blocked (the no-bcrypt test fails), touch a counter for a weak new password.
- [ ] 18.6 RED/GREEN: `POST /api/v1/password/change` e2e: `204`; missing or invalid token `401 invalid_token` with `WWW-Authenticate: Bearer`; wrong current password gives `400 { error: "invalid_current_password", message }`, changes nothing and revokes nothing; after 5 wrong attempts the correct password also gives the same `400` from that IP; weak new password `400 invalid_password` with no state change; every refresh token of the account (the caller's too) fails afterward while the current access token verifies until `exp`; failed changes feed the same counters as login; CORS bound to the token's `aud`.

- [ ] 18.7 Template TTL wording (retargeted from the README `TODO(U6)`, remove it when done): pass the confirmation and reset token TTLs to the email templates as variables, or keep the "24 hours" and "1 hour" wording pinned by a test against the token TTL constants.

## U19 OpenAPI, retention, e2e, docs and ops

**Group 1: OpenAPI**

- [ ] 19.1 RED/GREEN: route-table test lists the registered routes and asserts exactly 13 (3 at the root, 10 under `/api/v1`), no `/api/v1/oauth/*`, no `GET` under `/accounts/confirm` or `/password/*`, no page route.
- [ ] 19.2 RED/GREEN: OpenAPI 3.1 document generated by `npm run openapi:generate` into `openapi.json` (a build artifact, not a runtime route, so the route table stays at 13). Contract test: its paths equal the registered routes; bodies, success shapes, the error code table and the bearer scheme are present.

**Group 2: retention**

- [ ] 19.3 RED/GREEN: migration `1760000007000-RetentionIndexes` (`one_time_tokens(expires_at)`, partial index on `email_outbox(created_at)` for `sent` and `failed`); up, down, up.
- [ ] 19.4 RED/GREEN: `RetentionSweeper` with the ADR 35 windows (sessions and their refresh tokens one day after expiry, `one_time_tokens` one day after expiry, `sent` and `failed` outbox rows after 7 days), hourly, batches of 1,000, injected clock, started by `main.ts` only, awaits its drain on shutdown. Int tests: boundary rows kept and deleted, `pending` outbox rows never deleted, a live session with consumed tokens untouched (reuse detection survives), batch loop. Mutations: `<=` for `<` at the boundary, delete `pending` rows.
- [ ] 19.5 RED/GREEN: wiring test that `main.ts` starts the outbox poller, the abuse sweeper (limiter rows) and the retention sweeper, and the CLI and tests start none.

**Group 3: e2e suite**

- [ ] 19.6 e2e journeys on the shared factory: signup, confirm by POST using the fragment token from the fake sender, login, `/me` (exact four keys), refresh, replay after the grace window revokes, a lost-response retry inside the window keeps the session, logout; forgot for an unconfirmed account sends a confirmation mail that confirms it; wrong current password on change gives `400 invalid_current_password`; forgot, reset, old sessions dead, login with the new password; change password; two-app isolation (same email, cross-app token); audience mismatch verified through JWKS only; anti-enumeration equality of status and body across login, forgot, signup and resend, with a timing check on medians (tolerance, not strict).
- [ ] 19.7 Full migration chain test: run every migration, revert all to an empty schema, run them again.

**Group 4: docs, ops, one script and one config check**

- [ ] 19.8 `docs/integration-guide.md` and `docs/api-contract.md` already exist (landed from the `docs/integration-guide` branch, round 11 contract). This task is a status pass against the running service: flip every endpoint from PLANNED to IMPLEMENTED, confirm each statement (JWKS pinning and header rules, `iss`, `aud`, `typ`, RS256, JWKS cache and rotation timing, serialized refresh with the one-retry rule inside the grace window, token storage, CORS and preflight headers, fragment handling, error table, `429` and `Retry-After`, `/me` fields and profile ownership, change-password `400`, forgot for unconfirmed accounts, limits, email URL origin rule), and fix any difference in the guide or the code. Generate the contract's error table from the OpenAPI document where possible.
- [ ] 19.9 README ops runbook: migrations, `ops:revoke-all`, the cleanup jobs and retention windows (outbox, one-time tokens, sessions and refresh tokens, limiter rows), `TRUST_PROXY` behind a load balancer, https `AUTH_PUBLIC_BASE_URL` in production, `UNLOGGED` counters, key rotation pointer.
- [ ] 19.10 `docs/env-example-additions.md`: the exact lines the user must paste into `.env.example` (`AUTH_PUBLIC_BASE_URL`, `SMTP_*`, `MAIL_FROM`, `AUTH_SIGNING_KEYS[_FILE]`, `TRUST_PROXY`, `ABUSE_*` including `refresh_ip` and `confirm_ip`, `REFRESH_*` including `REFRESH_REUSE_GRACE_SECONDS`). The agent never edits `.env*`.
- [ ] 19.11 `docs/smoke-test.md`: manual browser checklist (Chromium, Firefox, Safari) with a static SPA at `http://localhost:5173`: signup, Mailpit link, fragment stripped, confirm, login, preflight, wrong-origin block, two-tab refresh, logout, forgot and reset, no cookies in DevTools. The user runs it and the result is recorded in apply-progress.
- [ ] 19.12 `scripts/login-load.mjs` (plain Node, no new dependency) and the gate: login P95 under 500 ms at pilot load (ADR 12), run manually. Final check: route table is exactly 13 routes and the proposal success criteria are walked through.
- [ ] 19.13 RED/GREEN: config check for the issuer. First verify what `app-config.ts` accepts today. `AUTH_PUBLIC_BASE_URL` in production must be an absolute `https` URL with no trailing slash, no query and no fragment, because it is copied verbatim into `iss` and the JWKS URL is `${iss}/.well-known/jwks.json`; development accepts `http`. Test: `https://auth.example/` (trailing slash) is rejected in production with an error naming the variable, `https://auth.example` passes, and a token issued under it has `iss` equal to the variable. Mutation: drop the refine, the trailing-slash case fails. Coordinate with 11.1, which edits the same file.

## Follow-ups (from U2 review, not scheduled above)

- [ ] F.1 Split liveness (`/live`) from readiness (`/health`) before any orchestrator deployment.
- [ ] F.2 Support `_FILE`-suffixed env vars for secrets other than the signing keys (ADR 20).
- [ ] F.3 Phase 2: `SET NOT NULL` migration for the two app email URLs once every row has values (ADR 39).
