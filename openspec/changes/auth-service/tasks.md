# Tasks: Auth Service MVP (Phase 1), API-only re-plan

Revision 2 (2026-10-05). U1-U6 are DONE and merged into `develop`; their entries below are condensed (full detail: git history and engram `sdd/auth-service/apply-progress`). The old U7-U10 are superseded. New units are U11-U19. Numbers U7-U10 are not reused, because discarded branches `u7a/u7b/u7c` and notes in engram still carry those names.

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 6,300-7,250 (additions + deletions, excludes `package-lock.json`). Raw feature estimates multiplied by 3.75 (the proposal's 3.5-4x), tests included. Raw sum is about 1,700 code lines plus about 330 documentation lines. |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | 22 stacked PRs across 9 units (a/b/c/d per unit below), each targeting <=400 lines. Two PRs may exceed 400 and are pre-flagged `size:exception`: U14c and U19b. |
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
              -> U15a -> U15b -> U16 -> U17a -> U17b -> U18a -> U18b -> U18c -> U19a -> U19b -> U19c -> U19d
```

Every PR targets `develop`, never `main`. The next branch starts from the updated `develop` after the previous PR merges. If a diff shows earlier units, update from `develop` first (rebase if unpublished, merge `develop` in if published).

### Suggested Work Units

| Unit | Goal | Est. lines (3.5-4x) | Depends on | Splits (each its own PR) |
|------|------|--------------------:|------------|--------------------------|
| U11 | Config https rule, app email URLs (`AppUrl`), CORS origin binding | 770-880 | U6 | a config + `AppUrl` + migration (260-300) / b use cases + CLI (280-320) / c origin binding + CORS routes (230-260) |
| U12 | transactional-email: links from app URLs with `#token` | 315-360 | U11 | single PR |
| U13 | abuse-protection: IP, config, counters, limiter, sweeper (all before bcrypt) | 910-1,040 | U12 | a domain + config + trust proxy (315-360) / b table + store (280-320) / c guard + sweeper (315-360) |
| U14 | session-auth A: sessions, refresh-token storage, login | 910-1,040 | U13 | a migration + schemas (230-260) / b repository (300-340) / c login (385-440, `size:exception` pre-flagged) |
| U15 | session-auth B: refresh rotation with reuse detection, logout, revoke-all | 610-700 | U14 | a refresh (280-320) / b logout + revoke use case + `ops:revoke-all` (330-380) |
| U16 | `AuthenticateBearerUseCase` and `GET /api/v1/me` | 315-360 | U11, U14 | single PR |
| U17 | user-accounts: confirm becomes POST, CORS, limits, `unconfigured_client` | 545-620 | U12, U13 | a confirm POST + origin binding + CORS (260-300) / b limits + caps + unconfigured (285-320) |
| U18 | password-management: forgot, reset, change | 720-820 | U15, U16, U17 | a forgot (245-280) / b reset (245-280) / c change (230-260) |
| U19 | OpenAPI, retention job, e2e, integration guide, ops, smoke test | 1,230-1,420 | all | a OpenAPI (245-280) / b retention (370-420, `size:exception` if over 400) / c e2e + migration chain (315-360) / d docs and ops (about 330, docs only) |

The units run sequentially: one writer. Sub-PRs also target `develop` in order.

**Order change from the brief:** transactional-email (U12) moves before accounts, sessions and passwords. Reason: U17a removes `GET /accounts/confirm`, and every email queued after U5 still links to it; the fragment links must exist first. U12 only needs the app URLs from U11.

## Spec/Design reconciliation

The spec and design were written in parallel. Resolved (edited in the artifact that disagreed):

1. **HTTP 429 (spec wins).** Login never returns 429: limited, blocked and locked logins return the generic `401`. IP-only limits on signup, resend, forgot and reset return `429` + `Retry-After` and depend only on IP and endpoint group. Per-account email caps return the normal response and send nothing (signup still creates the account). Design ADR 36 rewritten; proposal success criterion reworded.
2. **Account-exists email (spec wins).** Links to the app's `password_reset_url` with no token and no fragment. ADR 39 and the design's closed-questions note fixed.
3. **Password change (design wins).** Revokes ALL sessions including the caller's. Password-management spec now says so.
4. **No refresh grace window** (both agree). Guidance goes into the integration guide (U19d).
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

**U11a** `feat/u11a-config-app-urls` (260-300 lines)

- [x] 11.1 RED: `app-config.spec.ts` cases: `NODE_ENV=production` + `http://` `AUTH_PUBLIC_BASE_URL` throws `ConfigError` naming the variable; production + `https://` passes; development + `http://` passes. GREEN: case-sensitive `https://` prefix refine in `src/platform/config/app-config.ts`. Mutation: remove the refine, the production case fails. Add a README production note. (Also: compose `api` sets `NODE_ENV=development`, because the image defaults to production.)
- [x] 11.2 RED/GREEN/REFACTOR: `git mv` `PostResetRedirectUri` to `AppUrl` (`src/app-registry/domain/app-url.ts`) with the same table-driven rules (https, localhost http outside production, no userinfo, no fragment, relative/`javascript:`/`ftp:` rejected). Tests move with it and stay green. (Pulled in from U11b because the VO and column go away here: the `PostResetRedirectUri` use-case inputs, the CLI flags `--post-reset-redirect-uri` and `--clear-post-reset-redirect-uri`, their tests and README mentions are removed in U11a; U11b adds the new inputs.)
- [x] 11.3 RED: migration `1760000004000-AppEmailLinkUrls` int test: up adds nullable `email_confirmation_url` and `password_reset_url` and drops `post_reset_redirect_uri`; down restores it and drops both; up, down, up. Fix the `CreateApps` reversibility test for the new head. GREEN: migration, `AppRow`, `AppSchema`, `AppMapper` and domain `App` (`string | null`, round-trip including null).

**U11b** `feat/u11b-app-url-cli` (280-320 lines)

- [ ] 11.4 RED/GREEN: register requires both URLs validated through `AppUrl` (`isProduction` from config); update replaces but rejects clear or blank; invalid input persists nothing. Mutation: skip validation on update, the clear/blank test fails.
- [ ] 11.5 RED/GREEN/REFACTOR: CLI `--email-confirmation-url` and `--password-reset-url` (required on create, optional on update). Remove `--post-reset-redirect-uri`, `--clear-post-reset-redirect-uri` and their use-case code and tests; unknown option exits non-zero. Assert the specific `CliError` messages and that `NODE_ENV=production` rejects `http://localhost`. REFACTOR shared option parsing.
- [ ] 11.6 Docs: README CLI examples, a note that existing dev apps need one `app update` with both URLs before signup or forgot works.

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
- [ ] 13.2 RED/GREEN: `Scope`, `Policy` table and `CounterKey` (SHA-256 of scope + normalized parts, scopes cannot collide): defaults `login_ip` 100/15 min, `login_account_ip` 5/15 min block 15 min, `login_account` 50/1 h block 15 min, `email_ip` 20/1 h, `reset_ip` 20/1 h, `email_account` 3/1 h. Tests for defaults and env override.
- [ ] 13.3 RED/GREEN: zod config `TRUST_PROXY` (`false` default, hop count, or CIDR/Express names; `true` rejected at boot) and `ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS`, `_BLOCK_SECONDS` (positive integers).
- [ ] 13.4 RED/GREEN: `configureApp` sets Express `trust proxy` from config. e2e with a test-only echo route: spoofed `X-Forwarded-For` ignored when `false`; behind a trusted proxy the client is the first untrusted address from the right; malformed falls back to the peer. Mutation: `trust proxy = true`, the spoof test fails.

**U13b** `feat/u13b-abuse-store` (280-320 lines)

- [ ] 13.5 RED: migration `1760000005000-CreateAbuseCounters` int test: table is `UNLOGGED` (`relpersistence = 'u'`), PK `(scope, key)`, index on `expires_at`; up, down, up. GREEN: migration, `EntitySchema`, `AbuseCounterStore` port.
- [ ] 13.6 RED/GREEN: `PostgresAbuseCounterStore.hit` as the single atomic upsert of ADR 36 with the injected `Clock`: window rollover, threshold sets `blocked_until`, hits during a block do not extend it. Always uses the root `DataSource` manager. Int tests with a fixed clock; 10 parallel hits read count 10 and set `blocked_until` once; a rolled-back UoW leaves the count. Mutations: use the ALS manager, the rollback test fails; read-then-write instead of upsert, the concurrency test fails.
- [ ] 13.7 RED/GREEN: `blockedUntil(keys, now)` and `reset(scope, key)`; tests include an expired block and reset of a missing key.

**U13c** `feat/u13c-abuse-guard-sweeper` (315-360 lines)

- [ ] 13.8 RED/GREEN: `AbuseGuard` (application) with port fakes and a fixed clock, covering the spec scenarios: pair block while IP Y still passes, global lock, lock expiry, unknown email identical, threshold 3 configurable, success resets the pair counter and not the global one, attempts during a block do not extend it. Mutation: reset the global counter on success, the global-lock test fails.
- [ ] 13.9 RED/GREEN: decisions `allowed`, `ip_limited(retryAfterSeconds)` and `account_suppressed` for the email and reset checks. Store failure raises `TemporarilyUnavailable` (mapped to `503 temporarily_unavailable`) before any account lookup. Mutation: fail open, the 503 test fails.
- [ ] 13.10 RED/GREEN: `AbuseCounterSweeper` deletes expired rows every 5 min in batches of 1,000, started by `main.ts` only (outbox-poller pattern), awaits its drain on shutdown; `AbuseProtectionModule` exports the guard. Int test: expired rows deleted, live rows kept, batch loop. Check with `rg` that `abuse-protection` imports only `shared-kernel`.

## U14 Session-auth A: sessions and login

**U14a** `feat/u14a-session-persistence` (230-260 lines)

- [ ] 14.1 RED: migration `1760000006000-CreateAuthSessions` int test: `auth_sessions` (`revoked_reason` enum including `ops_revoke_all`, indexes on `user_id` and `expires_at`) and `refresh_tokens` (`token_hash bytea` PK, `session_id` FK indexed); up, down (drops the enum), up. GREEN.
- [ ] 14.2 RED/GREEN: domain `Session` and `RefreshToken`, `EntitySchema` rows, mappers with round-trip tests (null `revoked_at` and `consumed_at`, every enum value). Hexagonal check on imports.

**U14b** `feat/u14b-session-repository` (300-340 lines)

- [ ] 14.3 RED/GREEN: `SessionRepository.open(session, firstTokenHash)` and `consume(hash, appId, now)` as the single `UPDATE .. FROM auth_sessions .. RETURNING` of ADR 35. Int tests: wrong app, idle expiry, absolute expiry, revoked session each return null; N parallel consumes yield exactly one winner. Mutations: drop `consumed_at IS NULL`, the replay and concurrency tests fail; drop the `app_id` join, the wrong-app test fails.
- [ ] 14.4 RED/GREEN: `findTokenState`, `revoke(sessionId, reason)` (idempotent, keeps the first reason) and `revokeAllForUser(userId, reason)`. Int tests include other users untouched.

**U14c** `feat/u14c-login` (385-440 lines, `size:exception` pre-flagged if over 400 after trimming)

- [ ] 14.5 RED: `LoginUseCase` unit with recording fakes. Exactly one `verify` on each path (unknown email, wrong password, unconfirmed, success, unknown client, malformed email, password bcrypt cannot hash compared as `''`); zero `verify` when limited or blocked; both lockout counters recorded on a mismatch, including unknown emails; success resets the pair counter only; unknown client keys the sentinel `(unknown, IP)`. Mutations: return early for an unknown email, skip the dummy hash, skip the confirmed check, record a failure on success. The U7 ordering is a reference, not cherry-picked.
- [ ] 14.6 GREEN: `LoginUseCase`, boot-time dummy cost-12 hash provider, session issue in one `UnitOfWork` (open session + first token, then sign the access token with `aud` = `client_id`, `sub` = user id). Config `REFRESH_IDLE_TTL_SECONDS` (604800) and `REFRESH_ABSOLUTE_TTL_SECONDS` (2592000).
- [ ] 14.7 RED/GREEN: `POST /api/v1/auth/login` (zod body, `req.ip`, `Origin` passed to the use case). e2e: 200 body shape, `expires_in` 3600, `aud`, no `Set-Cookie`; byte-identical `401` (status, body, headers) for unknown email, wrong password, unconfirmed, locked, blocked, IP-limited and unknown client, and never `429`; correct password on an unconfirmed, locked or blocked account issues nothing; malformed body gives `400` without state wording; wrong-app origin gives the generic `401`; no `Origin` skips the binding; allow header bound to the app, no credentials header.

## U15 Session-auth B: refresh and logout

**U15a** `feat/u15a-refresh-rotation` (280-320 lines)

- [ ] 15.1 RED/GREEN: `RefreshSessionUseCase`: consume, successor and `last_used_at` in one UoW. Wrong app, unknown, expired and revoked give an identical `401 invalid_grant`. A consumed token of the same app revokes its session (`reuse_detected`); a consumed token of another app revokes nothing. Mutations: revoke on a wrong-app token, skip revoke on reuse; both fail a named test.
- [ ] 15.2 RED/GREEN: int concurrency: N parallel refreshes of one token give one success, and the session ends revoked including the winner's successor. Replay of R1 after R1 to R2 to R3 revokes R2 and R3. Rotation does not extend the absolute expiry; the idle expiry caps at the session expiry.
- [ ] 15.3 RED/GREEN: `POST /api/v1/auth/refresh` and e2e: same body shape as login, DB rows hold only hashes, invalid client gives `400 invalid_client`, origin binding and allow headers.

**U15b** `feat/u15b-logout-revoke-all` (330-380 lines)

- [ ] 15.4 RED/GREEN: `LogoutUseCase` and `POST /api/v1/auth/logout`: `204` for active, revoked, expired, unknown and other-app tokens; revokes only when the token belongs to the client's app; a later refresh fails; an issued access token still verifies until `exp`.
- [ ] 15.5 RED/GREEN: `RevokeAccountSessionsUseCase` (userId, reason) exported by `session-auth` for password-management; int test: all of that user's sessions revoked, other users untouched, reason stored.
- [ ] 15.6 RED/GREEN: CLI `ops:revoke-all` (nest-commander, requires `--yes`, prints the count, reason `ops_revoke_all`); the CLI boots without a signing key; e2e shows a refresh fails afterward. Mutation: omit the `--yes` guard, the guard test fails.

## U16 `/me`

**U16** `feat/u16-me-bearer` (315-360 lines)

- [ ] 16.1 RED/GREEN: `AuthenticateBearerUseCase` (`token-lifecycle/application`, ADR 32): read `aud` from the unverified payload only to pick the expectation, require an active app through `ResolveClientUseCase`, then `verify(token, { audience })`, then bind the origin to that app. Unit: missing, expired, bad signature, `none`, HS256, no `aud`, unknown `aud`, inactive `aud`, wrong `typ`, wrong-app origin all give one identical `unauthorized`; no `Origin` passes. Mutations: skip the verify call, skip the active-app check.
- [ ] 16.2 RED/GREEN: `GET /api/v1/me`: profile (`sub`, email, `email_verified`) of that account only, read through `UserRepository.findById` scoped to the token's app (add if missing). Unknown user is `401`. e2e: no password hash or internal fields, generic `401` bodies identical, allow header bound to the token's `aud`, app B origin gets none.

## U17 User-accounts changes

**U17a** `feat/u17a-confirm-post-cors` (260-300 lines)

- [ ] 17.1 RED/GREEN: `GET /api/v1/accounts/confirm` returns `404` and leaves the token unused; `POST /api/v1/accounts/confirm {token}` confirms, queues `welcome`, and every failure (malformed, unknown, used, expired, wrong purpose) gives an identical `400 invalid_or_expired_link`. Remove the GET controller.
- [ ] 17.2 RED/GREEN: `OneTimeTokenRepository.findAppByTokenHash` (read-only). The origin is bound to the token's app before the consume; a wrong origin or unknown token gives the same generic error and the token stays unused; no `Origin` passes. Mutation: consume before binding, the token-stays-unused test fails.
- [ ] 17.3 RED/GREEN: CORS on `accounts/signup`, `accounts/confirm`, `accounts/resend-confirmation`: preflight, own-origin allow header, other-app origin rejected with `400 invalid_client` and no allow header. Replace the "no CORS on accounts" note in README and ADR 31 (already marked superseded).

**U17b** `feat/u17b-accounts-limits` (285-320 lines)

- [ ] 17.4 RED/GREEN: signup and resend call `AbuseGuard` first, before bcrypt and any lookup. IP-limited gives `429 rate_limited` with `Retry-After`, identical for a new and an existing email, and runs no hash. A per-account cap gives the normal `202`; signup still creates the account but queues nothing; resend queues nothing. Store failure gives `503` before any lookup. Mutation: make the `429` depend on account existence, the equality test fails.
- [ ] 17.5 RED/GREEN: an app with a null `email_confirmation_url` gives `400 unconfigured_client` on signup and resend before any account work (no rows, no outbox, no hash).
- [ ] 17.6 RED/GREEN e2e: new, duplicate and capped signups are indistinguishable; remove the "resend gap accepted until Phase 2" wording from ADR 31 and README, since the limits now bound it.

## U18 Password management

**U18a** `feat/u18a-forgot` (245-280 lines)

- [ ] 18.1 RED/GREEN: `ForgotPasswordUseCase` order: client (`invalid_client` or `unconfigured_client` as `400`), `email_ip` (`429`), `email_account` (silent), then only for a confirmed account: a 1 h token that supersedes earlier unused reset tokens plus a `reset` outbox row, in one UoW. Always the generic `202`. Unit with fakes.
- [ ] 18.2 RED/GREEN: `POST /api/v1/password/forgot` and e2e: confirmed, unknown, other-app-only and unconfirmed give identical `202` and only the confirmed one queues mail; `GET /api/v1/password/forgot` is `404`; a provider outage still gives `202`; the 4th request in an hour is suppressed; IP limit gives `429`; CORS bound to `client_id`. Mutation: send mail for an unconfirmed account.

**U18b** `feat/u18b-reset` (245-280 lines)

- [ ] 18.3 RED/GREEN: `ResetPasswordUseCase {token, new_password}`: validate the password first (weak gives `400` and the token stays usable), `reset_ip` check, origin bound to the token's app (shared with 17.2), then one UoW: consume the token, write the hash and `password_changed_at`, `revokeAllForUser(password_reset)`. Used, expired (over 1 h), superseded and unknown give one generic error. Int tests: concurrent double submit has one winner; a revoke failure rolls back (hash unchanged, token unused). Mutations: revoke outside the UoW, ignore supersession.
- [ ] 18.4 RED/GREEN: `POST /api/v1/password/reset` e2e: `204`, no `Location`, hash is `$2b$12$`, `GET` is `404`, two sessions both die, `429` on IP limit, CORS bound through the token.

**U18c** `feat/u18c-change` (230-260 lines)

- [ ] 18.5 RED/GREEN: `ChangePasswordUseCase` via `AuthenticateBearerUseCase`: lockout counters are checked before bcrypt (blocked gives the generic invalid-credentials); a wrong current password records both counters; success resets the pair counter, writes the hash, `revokeAllForUser(password_changed)` and queues the `password-changed` notice, all in one UoW. Mutations: skip failure recording, exclude the caller's session from revocation.
- [ ] 18.6 RED/GREEN: `POST /api/v1/password/change` e2e: `204`; missing or invalid token `401`; wrong current password changes nothing; weak new password `400` with no state change; every refresh token of the account (the caller's too) fails afterward while the current access token verifies until `exp`; failed changes feed the same counters as login; CORS bound to the token's `aud`.

## U19 OpenAPI, retention, e2e, docs and ops

**U19a** `feat/u19a-openapi` (245-280 lines)

- [ ] 19.1 RED/GREEN: route-table test lists the registered routes and asserts exactly 13 (3 at the root, 10 under `/api/v1`), no `/api/v1/oauth/*`, no `GET` under `/accounts/confirm` or `/password/*`, no page route.
- [ ] 19.2 RED/GREEN: OpenAPI 3.1 document generated by `npm run openapi:generate` into `openapi.json` (a build artifact, not a runtime route, so the route table stays at 13). Contract test: its paths equal the registered routes; bodies, success shapes, the error code table and the bearer scheme are present.

**U19b** `feat/u19b-retention` (370-420 lines, `size:exception` only if over 400 after trimming)

- [ ] 19.3 RED/GREEN: migration `1760000007000-RetentionIndexes` (`one_time_tokens(expires_at)`, partial index on `email_outbox(created_at)` for `sent` and `failed`); up, down, up.
- [ ] 19.4 RED/GREEN: `RetentionSweeper` with the ADR 35 windows (sessions and their refresh tokens one day after expiry, `one_time_tokens` one day after expiry, `sent` and `failed` outbox rows after 7 days), hourly, batches of 1,000, injected clock, started by `main.ts` only, awaits its drain on shutdown. Int tests: boundary rows kept and deleted, `pending` outbox rows never deleted, a live session with consumed tokens untouched (reuse detection survives), batch loop. Mutations: `<=` for `<` at the boundary, delete `pending` rows.
- [ ] 19.5 RED/GREEN: wiring test that `main.ts` starts the outbox poller, the abuse sweeper (limiter rows) and the retention sweeper, and the CLI and tests start none.

**U19c** `feat/u19c-e2e-suite` (315-360 lines)

- [ ] 19.6 e2e journeys on the shared factory: signup, confirm by POST using the fragment token from the fake sender, login, `/me`, refresh, replay revokes, logout; forgot, reset, old sessions dead, login with the new password; change password; two-app isolation (same email, cross-app token); audience mismatch verified through JWKS only; anti-enumeration equality of status and body across login, forgot, signup and resend, with a timing check on medians (tolerance, not strict).
- [ ] 19.7 Full migration chain test: run every migration, revert all to an empty schema, run them again.

**U19d** `feat/u19d-docs-ops` (about 330 lines, docs and one script)

- [ ] 19.8 `docs/integration-guide.md`: pin the JWKS URL and never trust `jku`, `x5u` or embedded `jwk` headers; check `iss`, `aud`, `typ: at+jwt` and pin RS256; JWKS cache and rotation timing; serialize refreshes (one in-flight promise, `navigator.locks`, no grace window, so a race logs the user out); keep the access token in memory; refresh token storage and XSS risk; CORS (exact origins, no credentials, origin bound to `client_id`); fragment handling (`location.hash`, `history.replaceState` before third-party scripts); error code table; `429` and `Retry-After` handling; password change logs out every session; native clients send no `Origin`.
- [ ] 19.9 README ops runbook: migrations, `ops:revoke-all`, the cleanup jobs and retention windows (outbox, one-time tokens, sessions and refresh tokens, limiter rows), `TRUST_PROXY` behind a load balancer, https `AUTH_PUBLIC_BASE_URL` in production, `UNLOGGED` counters, key rotation pointer.
- [ ] 19.10 `docs/env-example-additions.md`: the exact lines the user must paste into `.env.example` (`AUTH_PUBLIC_BASE_URL`, `SMTP_*`, `MAIL_FROM`, `AUTH_SIGNING_KEYS[_FILE]`, `TRUST_PROXY`, `ABUSE_*`, `REFRESH_*`). The agent never edits `.env*`.
- [ ] 19.11 `docs/smoke-test.md`: manual browser checklist (Chromium, Firefox, Safari) with a static SPA at `http://localhost:5173`: signup, Mailpit link, fragment stripped, confirm, login, preflight, wrong-origin block, two-tab refresh, logout, forgot and reset, no cookies in DevTools. The user runs it and the result is recorded in apply-progress.
- [ ] 19.12 `scripts/login-load.mjs` (plain Node, no new dependency) and the gate: login P95 under 500 ms at pilot load (ADR 12), run manually. Final check: route table is exactly 13 routes and the proposal success criteria are walked through.

## Follow-ups (from U2 review, not scheduled above)

- [ ] F.1 Split liveness (`/live`) from readiness (`/health`) before any orchestrator deployment.
- [ ] F.2 Support `_FILE`-suffixed env vars for secrets other than the signing keys (ADR 20).
- [ ] F.3 Phase 2: `SET NOT NULL` migration for the two app email URLs once every row has values (ADR 39).
