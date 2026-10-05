# Tasks: Auth Service MVP (Phase 1), API-only re-plan

Revision 2 (2026-10-05). U1-U6 are DONE and merged into `develop`; their entries below are condensed (full detail: git history and engram `sdd/auth-service/apply-progress`). The old U7-U10 are superseded. New units are U11-U19. Numbers U7-U10 are not reused, because discarded branches `u7a/u7b/u7c` and notes in engram still carry those names.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 6,850-7,860 (additions + deletions, excludes `package-lock.json`). Raw feature estimates multiplied by 3.75 (the proposal's 3.5-4x), tests included. Round 11 amendment added about 140-165 raw lines (about 525-620 changed lines): grace window, `refresh_ip` and `confirm_ip` limits, `/me` fields, change-password `400`, forgot for unconfirmed accounts, preflight headers, email URL origin rule (U11b note). The integration guide and API contract now ship from `docs/` ahead of U19d, which shrinks. |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 23 stacked PRs across 9 units (a/b/c/d per unit below), each targeting <=400 lines. Three PRs exceed 400 and are flagged `size:exception`: U11a (570 actual, merged), U14c and U19b. U15c and U16 sit at the 400 edge after round 11 and must be trimmed or split if they measure over. |
| Delivery strategy | ask-on-risk, resolved as chained PRs |
| Chain strategy | stacked-to-develop (every PR targets `develop`) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-develop
400-line budget risk: High

> No decision is pending. Delivery and chain strategy are resolved. Measure `additions + deletions` before each PR. If U14c or U19b measures above 400 after trimming overlapping tests, record `size:exception` on that PR; every other PR must land at or under 400 or be split further.

### Branch flow

```
develop: ... U6 -> U11a -> U11b -> U11c -> U12 -> U13a -> U13b -> U13c -> U14a -> U14b -> U14c
              -> U15a -> U15b -> U15c -> U16 -> U17a -> U17b -> U18a -> U18b -> U18c -> U19a -> U19b -> U19c -> U19d
```

Every PR targets `develop`, never `main`. The next branch starts from the updated `develop` after the previous PR merges. If a diff shows earlier units, update from `develop` first (rebase if unpublished, merge `develop` in if published).

### Suggested Work Units

| Unit | Goal | Est. lines (3.5-4x) | Depends on | Splits (each its own PR) |
|------|------|--------------------:|------------|--------------------------|
| U11 | Config https rule, app email URLs (`AppUrl`), CORS origin binding | about 920-1,030 (a: 541 actual) | U6 | a config + `AppUrl` + migration (actual 541, `size:exception`: removing the old post-reset code was pulled forward from b) / b use cases + CLI (about 150-190 after the pull-forward) / c origin binding + CORS routes (230-260) |
| U12 | transactional-email: links from app URLs with `#token` | 315-360 | U11 | single PR |
| U13 | abuse-protection: IP, config, counters, limiter, sweeper (all before bcrypt) | 930-1,060 | U12 | a domain + config + trust proxy (335-380, includes `refresh_ip` and `confirm_ip` scopes) / b table + store (280-320) / c guard + sweeper (315-360) |
| U14 | session-auth A: sessions, refresh-token storage, login | 955-1,085 | U13 | a migration + schemas (275-305, includes the grace columns) / b repository (300-340) / c login (385-440, `size:exception` pre-flagged) |
| U15 | session-auth B: refresh rotation with reuse detection and grace window, logout, revoke-all | 875-1,005 | U14 | a refresh + `refresh_ip` + origin rule (320-360) / b reuse grace window (205-245) / c logout + revoke use case + `ops:revoke-all` (350-400) |
| U16 | `AuthenticateBearerUseCase` and `GET /api/v1/me` | 355-400 | U11, U14 | single PR |
| U17 | user-accounts: confirm becomes POST, CORS, limits, `unconfigured_client` | 615-690 | U12, U13 | a confirm POST (`200 {message}`) + origin binding + CORS + preflight headers + `confirm_ip` (330-370) / b limits + caps + unconfigured (285-320) |
| U18 | password-management: forgot, reset, change | 790-890 | U15, U16, U17 | a forgot incl. unconfirmed accounts (285-320) / b reset (245-280) / c change incl. `invalid_current_password` (260-290) |
| U19 | OpenAPI, retention job, e2e, integration guide status pass, ops, smoke test | 1,205-1,440 | all | a OpenAPI (245-280) / b retention (370-420, `size:exception` if over 400) / c e2e + migration chain + grace journey (350-400) / d docs status pass, ops, issuer check (270-310) |

U11 row is not edited here (a parallel branch owns it). The U11b origin rule (11.4a) is now folded into U11b; the totals above already include it.

The units run sequentially: one writer. Sub-PRs also target `develop` in order.

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

**U11b** `feat/u11b-app-url-cli` (about 400 lines after trimming duplicate tests; the removal of the post-reset use-case inputs, CLI flags, tests and README mentions already landed in U11a; includes 11.4a, folded in from the round 11 amendment)

- [x] 11.4 RED/GREEN: register requires both URLs validated through `AppUrl` (`isProduction` from config); update replaces but rejects clear or blank; invalid input persists nothing. Mutation: skip validation on update, the clear/blank test fails.
- [x] 11.5 RED/GREEN/REFACTOR: CLI `--email-confirmation-url` and `--password-reset-url` (required on create, optional on update). Assert that an unknown option such as `--post-reset-redirect-uri` exits non-zero, and assert the specific `CliError` messages. Re-add the CLI test that `NODE_ENV=production` rejects `http://localhost` for both URLs (verify S1, dropped with the old post-reset tests in U11a). REFACTOR shared option parsing. (Flag and use-case removal already done in 11.2.)
- [x] 11.6 Docs: README `app create` / `app update` examples with both new flags (the `--post-reset-redirect-uri` mentions are already gone), a note that existing dev apps need one `app update` with both URLs before signup or forgot works.

- [x] 11.4a RED/GREEN: email URL origin rule (app-registry spec, ADR 39). The origin of `email_confirmation_url` and `password_reset_url` must be one of the app's `allowed_origins` (compared after the `AllowedOrigin` normalization via `URL.origin`). Enforced as an `App` invariant (`email_url_origin_not_allowed`) in `App.create`, and `App.update` rebuilds through it, so it holds on create and on update, including an update that removes an origin a stored URL uses. Errors name the field and the origin, and nothing is persisted. `AppUrl.create` takes an optional label so errors name the field (`Invalid email_confirmation_url: ...`). Legacy apps with null URLs skip the rule. An app needs at least one allowed origin: create without `--origin` fails with `at least one --origin is required`. Mutation: skip the check on update, the orphaned-origins test fails. CLI messages asserted as in 11.5.

**U11c** `feat/u11c-origin-binding` (230-260 lines)

- [ ] 11.7 RED: `ResolveClientUseCase.execute(clientId, { origin })` unit: no origin passes; the app's own origin passes; another active app's origin gives `invalid_client`; inactive or unknown gives `invalid_client`; comparison is exact (case, trailing slash). GREEN. Mutation: check "any active app" instead of the app's own origins, the wrong-app case fails.
- [ ] 11.8 RED/GREEN: `AppCorsMiddleware` route list becomes the 10 API routes of ADR 38; preflight answers for any active app (204); never `Access-Control-Allow-Credentials`, never a wildcard; the 30 s cache stays. e2e on a test-only route group proves preflight, allow header and no credentials header. Each later endpoint unit adds its own wrong-origin e2e.

## U12 Transactional-email app links

**U12** `feat/u12-email-app-links` (315-360 lines)

- [ ] 12.1 RED: `EmailLinks` unit: confirmation link `https://a.example/confirm#token=<percent-encoded>`; reset link likewise; a null URL throws `UnconfiguredLink`; no output contains `AUTH_PUBLIC_BASE_URL`. GREEN: rewrite `src/transactional-email/application/email-links.ts` from the app record.
- [ ] 12.2 RED/GREEN: `OutboxWorker` builds links at send time from the current app (`findById`); a null URL marks the row `failed` at once with the payload purged and no token in logs. Update existing worker tests.
- [ ] 12.3 RED/GREEN: templates `confirmation`, `reset` use the built link; `account-exists` links to `password_reset_url` with no token and no `#`; `welcome` and `password-changed` unchanged. Renderer tests: no password, no `AUTH_PUBLIC_BASE_URL` anywhere, `account-exists` has no token.
- [ ] 12.4 RED/GREEN: update `email-pipeline.int-spec` (Mailpit): the delivered mail carries `app URL + #token=`. Mutation: build from `AUTH_PUBLIC_BASE_URL`, the pipeline and link tests fail. Update the README TTL TODO and ADR 30 payload note if they mention link bases.

## U13 Abuse protection (all of it lands before any bcrypt path)

**U13a** `feat/u13a-abuse-domain-config` (315-360 lines)

- [ ] 13.1 RED/GREEN: `ClientIp` value object (`src/abuse-protection/domain/`): IPv4-mapped IPv6 becomes IPv4; IPv6 keyed on its /64; undefined or malformed falls back to the socket peer. Table-driven.
- [ ] 13.2 RED/GREEN: `Scope`, `Policy` table and `CounterKey` (SHA-256 of scope + normalized parts, scopes cannot collide): defaults `login_ip` 100/15 min, `login_account_ip` 5/15 min block 15 min, `login_account` 50/1 h block 15 min, `email_ip` 20/1 h, `reset_ip` 20/1 h (keyed by IP only), `confirm_ip` 20/1 h (IP only), `refresh_ip` 60/15 min (client + IP), `email_account` 3/1 h. Tests for defaults and env override, and that `reset_ip`, `confirm_ip` and `refresh_ip` keys cannot collide for the same IP.
- [ ] 13.3 RED/GREEN: zod config `TRUST_PROXY` (`false` default, hop count, or CIDR/Express names; `true` rejected at boot) and `ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS`, `_BLOCK_SECONDS` (positive integers).
- [ ] 13.4 RED/GREEN: `configureApp` sets Express `trust proxy` from config. e2e with a test-only echo route: spoofed `X-Forwarded-For` ignored when `false`; behind a trusted proxy the client is the first untrusted address from the right; malformed falls back to the peer. Mutation: `trust proxy = true`, the spoof test fails.

**U13b** `feat/u13b-abuse-store` (280-320 lines)

- [ ] 13.5 RED: migration `1760000005000-CreateAbuseCounters` int test: table is `UNLOGGED` (`relpersistence = 'u'`), PK `(scope, key)`, index on `expires_at`; up, down, up. GREEN: migration, `EntitySchema`, `AbuseCounterStore` port.
- [ ] 13.6 RED/GREEN: `PostgresAbuseCounterStore.hit` as the single atomic upsert of ADR 36 with the injected `Clock`: window rollover, threshold sets `blocked_until`, hits during a block do not extend it. Always uses the root `DataSource` manager. Int tests with a fixed clock; 10 parallel hits read count 10 and set `blocked_until` once; a rolled-back UoW leaves the count. Mutations: use the ALS manager, the rollback test fails; read-then-write instead of upsert, the concurrency test fails.
- [ ] 13.7 RED/GREEN: `blockedUntil(keys, now)` and `reset(scope, key)`; tests include an expired block and reset of a missing key.

**U13c** `feat/u13c-abuse-guard-sweeper` (315-360 lines)

- [ ] 13.8 RED/GREEN: `AbuseGuard` (application) with port fakes and a fixed clock, covering the spec scenarios: pair block while IP Y still passes, global lock, lock expiry, unknown email identical, threshold 3 configurable, success resets the pair counter and not the global one, attempts during a block do not extend it. Mutation: reset the global counter on success, the global-lock test fails.
- [ ] 13.9 RED/GREEN: decisions `allowed`, `ip_limited(retryAfterSeconds)` and `account_suppressed` for the email, reset, confirm and refresh checks (`retryAfterSeconds` is an integer, at least 1). Store failure raises `TemporarilyUnavailable` (mapped to `503 temporarily_unavailable`) before any account lookup. Mutation: fail open, the 503 test fails.
- [ ] 13.10 RED/GREEN: `AbuseCounterSweeper` deletes expired rows every 5 min in batches of 1,000, started by `main.ts` only (outbox-poller pattern), awaits its drain on shutdown; `AbuseProtectionModule` exports the guard. Int test: expired rows deleted, live rows kept, batch loop. Check with `rg` that `abuse-protection` imports only `shared-kernel`.

## U14 Session-auth A: sessions and login

**U14a** `feat/u14a-session-persistence` (230-260 lines)

- [ ] 14.1 RED: migration `1760000006000-CreateAuthSessions` int test: `auth_sessions` (`revoked_reason` enum including `ops_revoke_all`, indexes on `user_id` and `expires_at`) and `refresh_tokens` (`token_hash bytea` PK, `session_id` FK indexed, plus the grace-window columns `replaced_by_hash bytea NULL`, `consumed_ip_hash bytea NULL`, `grace_used_at NULL`, `revoked_at NULL`, ADR 35); up, down (drops the enum), up. GREEN.
- [ ] 14.2 RED/GREEN: domain `Session` and `RefreshToken`, `EntitySchema` rows, mappers with round-trip tests (null `revoked_at`, `consumed_at`, `replaced_by_hash`, `consumed_ip_hash` and `grace_used_at`, every enum value). Hexagonal check on imports.

**U14b** `feat/u14b-session-repository` (300-340 lines)

- [ ] 14.3 RED/GREEN: `SessionRepository.open(session, firstTokenHash)` and `consume(hash, appId, now, successorHash, ipHash)` as the single `UPDATE .. FROM auth_sessions .. RETURNING` of ADR 35, storing `replaced_by_hash` and `consumed_ip_hash`. Int tests: wrong app, idle expiry, absolute expiry, revoked session and a token with `revoked_at` each return null; N parallel consumes yield exactly one winner. Mutations: drop `consumed_at IS NULL`, the replay and concurrency tests fail; drop the `app_id` join, the wrong-app test fails; drop `revoked_at IS NULL`, the revoked-token test fails.
- [ ] 14.4 RED/GREEN: `findTokenState` (including consumed time, IP hash, grace-used and revoked flags), `revoke(sessionId, reason)` (idempotent, keeps the first reason), `revokeAllForUser(userId, reason)`, `claimGrace(hash, now)` (returns `replaced_by_hash` once, null on the second call, concurrent claims yield one winner), `revokeToken(hash, now)` (false when the token was already used or revoked) and `addToken`. Int tests include other users untouched.

**U14c** `feat/u14c-login` (385-440 lines, `size:exception` pre-flagged if over 400 after trimming)

- [ ] 14.5 RED: `LoginUseCase` unit with recording fakes. Exactly one `verify` on each path (unknown email, wrong password, unconfirmed, success, unknown client, malformed email, password bcrypt cannot hash compared as `''`); zero `verify` when limited or blocked; both lockout counters recorded on a mismatch, including unknown emails; success resets the pair counter only; unknown client keys the sentinel `(unknown, IP)`. Mutations: return early for an unknown email, skip the dummy hash, skip the confirmed check, record a failure on success. The U7 ordering is a reference, not cherry-picked.
- [ ] 14.6 GREEN: `LoginUseCase`, boot-time dummy cost-12 hash provider, session issue in one `UnitOfWork` (open session + first token, then sign the access token with `aud` = `client_id`, `sub` = user id). Config `REFRESH_IDLE_TTL_SECONDS` (604800) and `REFRESH_ABSOLUTE_TTL_SECONDS` (2592000).
- [ ] 14.7 RED/GREEN: `POST /api/v1/auth/login` (zod body, `req.ip`, `Origin` passed to the use case). e2e: 200 body shape, `expires_in` 3600, `aud`, no `Set-Cookie`; byte-identical `401` (status, body, headers) for unknown email, wrong password, unconfirmed, locked, blocked, IP-limited and unknown client, and never `429`; correct password on an unconfirmed, locked or blocked account issues nothing; malformed body gives `400 invalid_request` without state wording; wrong-app origin gives the generic `401`; no `Origin` skips the binding; allow header bound to the app, no credentials header.

## U15 Session-auth B: refresh and logout

**U15a** `feat/u15a-refresh-rotation` (320-360 lines). The grace window is NOT in this PR: here every reuse revokes the session.

- [ ] 15.1 RED/GREEN: `RefreshSessionUseCase`: consume (with the successor hash and the `ClientIp` hash), successor and `last_used_at` in one UoW. Wrong app, unknown and expired give an identical `401 invalid_grant`. A consumed or revoked token of the same app revokes its session (`reuse_detected`); a consumed token of another app revokes nothing. Mutations: revoke on a wrong-app token, skip revoke on reuse; both fail a named test.
- [ ] 15.2 RED/GREEN: int concurrency: N parallel refreshes of one token give one success, and the session ends revoked including the winner's successor. Replay of R1 after R1 to R2 to R3 revokes R2 and R3. Rotation does not extend the absolute expiry; the idle expiry caps at the session expiry.
- [ ] 15.3 RED/GREEN: `POST /api/v1/auth/refresh` and e2e: same body shape as login, DB rows hold only hashes, malformed body gives `400 invalid_request`, unknown or inactive client gives `400 invalid_client`, an `Origin` not bound to `client_id` gives the same `401 invalid_grant` as an unknown token with no allow header and the token unconsumed (mutation: check the origin after the consume, the token-unconsumed test fails), allow headers bound to the app.
- [ ] 15.3a RED/GREEN: `refresh_ip` (`AbuseGuard`, before any token lookup): an over-limit IP gets `429 rate_limited` with an integer `Retry-After`, identical for a valid and an invalid token, with no token consumed; the limit is configurable. Mutation: run the check after the lookup, the no-lookup assertion fails.

**U15b** `feat/u15b-refresh-grace` (205-245 lines). Strict TDD, one RED test per scenario of the session-auth spec, every guard mutation-checked.

- [ ] 15.7 Config: `REFRESH_REUSE_GRACE_SECONDS` (zod, non-negative integer, default 10, `0` disables) with tests for the default, an override and a negative value rejected.
- [ ] 15.8 RED: `RefreshSessionUseCase` unit with an injected `Clock`, fakes and a fixed `ClientIp`, one test each: (a) reuse of R1 inside the window from the same IP returns 200 with a pair R3, R2 revoked, session NOT revoked, R3 is not R2; (b) inside the window from a different IP revokes the session; (c) after the window revokes the session; (d) a second reuse of R1 inside the window revokes the session; (e) R2 already used (R1 to R2 to R3) then R1 inside the window revokes the session; (f) grace `0` revokes; (g) a revoked successor R2 presented later revokes the session; (h) IPv6 addresses in the same /64 count as the same IP; (i) a token with `revoked_at` never takes the grace path. GREEN: the grace branch of ADR 35 (`claimGrace`, `revokeToken`, `addToken`, fresh access token, one UoW; revoke the session on any zero-row step). REFACTOR: extract the eligibility decision into a pure domain function with its own table-driven test.
- [ ] 15.9 Mutations (each must fail a named test, then restore): drop the same-IP check, (b) fails; drop the window check, (c) fails; skip `grace_used_at` (allow a second grace), (d) fails; skip the successor revoke, (a) and (g) fail; skip the successor-unused check, (e) fails; return the old successor instead of a fresh token, (a) fails. Record each in apply-progress.
- [ ] 15.10 RED/GREEN: int tests on real Postgres: N parallel presentations of one rotated token inside the window from one IP give exactly one grace success and the session ends revoked on the next concurrent reuse; a rolled-back grace UoW leaves `grace_used_at` unset; the table holds hashes only after a grace reuse (no raw token recoverable). e2e: lost-response retry (rotate, ignore the response, retry the old token from the same IP) returns 200 and keeps the session; the same retry after advancing the clock past the window logs out.

**U15c** `feat/u15c-logout-revoke-all` (350-400 lines)

- [ ] 15.4 RED/GREEN: `LogoutUseCase` and `POST /api/v1/auth/logout`: `204` for active, revoked, expired, unknown and other-app tokens; revokes only when the token belongs to the client's app AND any `Origin` is bound to that app (an unbound origin still gets `204`, revokes nothing and gets no allow header); a malformed body gives `400 invalid_request`; a later refresh fails; an issued access token still verifies until `exp`. Mutation: ignore the origin binding, the unbound-origin test fails.
- [ ] 15.5 RED/GREEN: `RevokeAccountSessionsUseCase` (userId, reason) exported by `session-auth` for password-management; int test: all of that user's sessions revoked, other users untouched, reason stored.
- [ ] 15.6 RED/GREEN: CLI `ops:revoke-all` (nest-commander, requires `--yes`, prints the count, reason `ops_revoke_all`); the CLI boots without a signing key; e2e shows a refresh fails afterward. Mutation: omit the `--yes` guard, the guard test fails.

## U16 `/me`

**U16** `feat/u16-me-bearer` (355-400 lines; trim or split if it measures over 400)

- [ ] 16.1 RED/GREEN: `AuthenticateBearerUseCase` (`token-lifecycle/application`, ADR 32): read `aud` from the unverified payload only to pick the expectation, require an active app through `ResolveClientUseCase`, then `verify(token, { audience })`, then bind the origin to that app. Unit: missing, expired, bad signature, `none`, HS256, no `aud`, unknown `aud`, inactive `aud`, wrong `typ`, wrong-app origin all give one identical `unauthorized`; no `Origin` passes. Mutations: skip the verify call, skip the active-app check.
- [ ] 16.2 RED/GREEN: `GET /api/v1/me`: exactly `{ id, email, email_verified, created_at }` of that account only (`id` equals `sub`, `email_verified` boolean from `email_verified_at`, `created_at` ISO 8601 UTC), read through `UserRepository.findById` scoped to the token's app (add if missing). Auth stores no name or profile, and a test asserts the response has no other keys. Unknown user is `401`. e2e: no password hash or internal fields, `401 { error: "invalid_token", message }` with `WWW-Authenticate: Bearer`, byte-identical for every cause, allow header bound to the token's `aud`, app B origin gets none. There is no limiter on `/me`: a test documents that many calls stay `200` and the guard is not called. Mutation: add `name` or `password_hash` to the mapper output, the exact-keys test fails.

## U17 User-accounts changes

**U17a** `feat/u17a-confirm-post-cors` (330-370 lines)

- [ ] 17.1 RED/GREEN: `GET /api/v1/accounts/confirm` returns `404` and leaves the token unused; `POST /api/v1/accounts/confirm {token}` confirms, queues `welcome`, returns `200 { "message": "Your email address has been confirmed." }` with no tokens issued, and every failure (malformed, unknown, used, expired, wrong purpose) gives an identical `400 invalid_or_expired_link`; a missing `token` field gives `400 invalid_request`. Remove the GET controller.
- [ ] 17.1a RED/GREEN: `confirm_ip` limit through `AbuseGuard`, before any token lookup: over the limit gives `429 rate_limited` with an integer `Retry-After`, identical for a valid and an invalid token, token untouched. Mutation: run the check after the lookup, the no-lookup assertion fails.
- [ ] 17.2 RED/GREEN: `OneTimeTokenRepository.findAppByTokenHash` (read-only). The origin is bound to the token's app before the consume; a wrong origin or unknown token gives the same generic error and the token stays unused; no `Origin` passes. Mutation: consume before binding, the token-stays-unused test fails.
- [ ] 17.3 RED/GREEN: CORS on `accounts/signup`, `accounts/confirm`, `accounts/resend-confirmation`: preflight, own-origin allow header, other-app origin rejected with `400 invalid_client` and no allow header. Also complete the preflight header set in `AppCorsMiddleware` (route list stays with 11.8): `204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization` (fixed, not echoed: a request asking for `X-Custom` still gets the fixed list), `Access-Control-Max-Age: 600`, `Vary: Origin` on preflight and actual responses, never `Access-Control-Allow-Credentials`. Mutation: echo the requested headers, the fixed-list test fails. Replace the "no CORS on accounts" note in README and ADR 31 (already marked superseded).

**U17b** `feat/u17b-accounts-limits` (285-320 lines)

- [ ] 17.4 RED/GREEN: signup and resend call `AbuseGuard` first, before bcrypt and any lookup. IP-limited gives `429 rate_limited` with `Retry-After`, identical for a new and an existing email, and runs no hash. A per-account cap gives the normal `202`; signup still creates the account but queues nothing; resend queues nothing. Store failure gives `503` before any lookup. Mutation: make the `429` depend on account existence, the equality test fails.
- [ ] 17.5 RED/GREEN: an app with a null `email_confirmation_url` OR a null `password_reset_url` gives `400 unconfigured_client` on signup and resend before any account work (no rows, no outbox, no hash). Both are checked because signup for an existing email sends the account-exists mail, which links to `password_reset_url` (12.3). Scenario: app with only `email_confirmation_url` set (legacy app half-updated) gets `unconfigured_client` on signup and resend, and the reverse case (only `password_reset_url`) does too.
- [ ] 17.6 RED/GREEN e2e: new, duplicate and capped signups are indistinguishable (the fixed `message` texts of signup and resend are asserted byte for byte, and every error body has string `error` and `message`); remove the "resend gap accepted until Phase 2" wording from ADR 31 and README, since the limits now bound it.

## U18 Password management

**U18a** `feat/u18a-forgot` (285-320 lines)

- [ ] 18.1 RED/GREEN: `ForgotPasswordUseCase` order: client (`invalid_client`, or `unconfigured_client` as `400` when EITHER `email_confirmation_url` OR `password_reset_url` is null, since the unconfirmed-account path sends a confirmation link and the confirmed path a reset link), `email_ip` (`429`), `email_account` (silent), then by account state, in one UoW: confirmed gives a 1 h token that supersedes earlier unused reset tokens plus a `reset` outbox row; UNCONFIRMED gives a new confirmation token that supersedes earlier unused confirmation tokens (reuse the resend code path) plus a `confirmation` outbox row, and never a reset token; unknown or other-app-only gives nothing. Always the fixed generic `202` body `{ "message": "If an account exists for this address, an email is on its way." }`. Unit with fakes.
- [ ] 18.2 RED/GREEN: `POST /api/v1/password/forgot` and e2e: confirmed, unconfirmed, unknown and other-app-only give byte-identical `202`; confirmed queues a `reset`, unconfirmed queues a `confirmation` (and no reset token exists for it), unknown queues nothing; the confirmation mail from forgot confirms the account through `POST /accounts/confirm`; `GET /api/v1/password/forgot` is `404`; a provider outage still gives `202`; emails from forgot for an unconfirmed account count toward the per-account cap (the 4th mail in an hour across signup, resend and forgot is suppressed); IP limit gives `429`; a malformed body gives `400 invalid_request`; CORS bound to `client_id`. Mutations: send a reset for an unconfirmed account; do not count the unconfirmed email toward the cap; both fail a named test.

**U18b** `feat/u18b-reset` (245-280 lines)

- [ ] 18.3 RED/GREEN: `ResetPasswordUseCase {token, new_password}`: validate the password first (weak gives `400` and the token stays usable), `reset_ip` check, origin bound to the token's app (shared with 17.2), then one UoW: consume the token, write the hash and `password_changed_at`, `revokeAllForUser(password_reset)`. Used, expired (over 1 h), superseded and unknown give one generic error. Int tests: concurrent double submit has one winner; a revoke failure rolls back (hash unchanged, token unused). Mutations: revoke outside the UoW, ignore supersession.
- [ ] 18.4 RED/GREEN: `POST /api/v1/password/reset` e2e: `204`, no `Location`, hash is `$2b$12$`, `GET` is `404`, two sessions both die, `429` on IP limit, CORS bound through the token.

**U18c** `feat/u18c-change` (260-290 lines)

- [ ] 18.5 RED/GREEN: `ChangePasswordUseCase` via `AuthenticateBearerUseCase`. Order: bearer, body shape (`400 invalid_request`), new-password rules (`400 invalid_password`, no counter touched), lockout state (blocked or locked gives `400 invalid_current_password` even for the correct password, with NO bcrypt), compare. A wrong current password gives `400 invalid_current_password` (never `401`) and records both counters; success resets the pair counter, writes the hash, `revokeAllForUser(password_changed)` and queues the `password-changed` notice, all in one UoW. Mutations: skip failure recording, exclude the caller's session from revocation, return `401` for a wrong current password (the status test fails), run bcrypt while blocked (the no-bcrypt test fails), touch a counter for a weak new password.
- [ ] 18.6 RED/GREEN: `POST /api/v1/password/change` e2e: `204`; missing or invalid token `401 invalid_token` with `WWW-Authenticate: Bearer`; wrong current password gives `400 { error: "invalid_current_password", message }`, changes nothing and revokes nothing; after 5 wrong attempts the correct password also gives the same `400` from that IP; weak new password `400 invalid_password` with no state change; every refresh token of the account (the caller's too) fails afterward while the current access token verifies until `exp`; failed changes feed the same counters as login; CORS bound to the token's `aud`.

## U19 OpenAPI, retention, e2e, docs and ops

**U19a** `feat/u19a-openapi` (245-280 lines)

- [ ] 19.1 RED/GREEN: route-table test lists the registered routes and asserts exactly 13 (3 at the root, 10 under `/api/v1`), no `/api/v1/oauth/*`, no `GET` under `/accounts/confirm` or `/password/*`, no page route.
- [ ] 19.2 RED/GREEN: OpenAPI 3.1 document generated by `npm run openapi:generate` into `openapi.json` (a build artifact, not a runtime route, so the route table stays at 13). Contract test: its paths equal the registered routes; bodies, success shapes, the error code table and the bearer scheme are present.

**U19b** `feat/u19b-retention` (370-420 lines, `size:exception` only if over 400 after trimming)

- [ ] 19.3 RED/GREEN: migration `1760000007000-RetentionIndexes` (`one_time_tokens(expires_at)`, partial index on `email_outbox(created_at)` for `sent` and `failed`); up, down, up.
- [ ] 19.4 RED/GREEN: `RetentionSweeper` with the ADR 35 windows (sessions and their refresh tokens one day after expiry, `one_time_tokens` one day after expiry, `sent` and `failed` outbox rows after 7 days), hourly, batches of 1,000, injected clock, started by `main.ts` only, awaits its drain on shutdown. Int tests: boundary rows kept and deleted, `pending` outbox rows never deleted, a live session with consumed tokens untouched (reuse detection survives), batch loop. Mutations: `<=` for `<` at the boundary, delete `pending` rows.
- [ ] 19.5 RED/GREEN: wiring test that `main.ts` starts the outbox poller, the abuse sweeper (limiter rows) and the retention sweeper, and the CLI and tests start none.

**U19c** `feat/u19c-e2e-suite` (350-400 lines)

- [ ] 19.6 e2e journeys on the shared factory: signup, confirm by POST using the fragment token from the fake sender, login, `/me` (exact four keys), refresh, replay after the grace window revokes, a lost-response retry inside the window keeps the session, logout; forgot for an unconfirmed account sends a confirmation mail that confirms it; wrong current password on change gives `400 invalid_current_password`; forgot, reset, old sessions dead, login with the new password; change password; two-app isolation (same email, cross-app token); audience mismatch verified through JWKS only; anti-enumeration equality of status and body across login, forgot, signup and resend, with a timing check on medians (tolerance, not strict).
- [ ] 19.7 Full migration chain test: run every migration, revert all to an empty schema, run them again.

**U19d** `feat/u19d-docs-ops` (270-310 lines, docs, one script and one config check)

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
