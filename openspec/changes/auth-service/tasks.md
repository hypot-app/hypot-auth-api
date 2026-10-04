# Tasks: Auth Service MVP (Phase 1)

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 4,870-6,720 (excludes `package-lock.json`). There is no generated client. TypeORM adds about 500 lines of schemas, mappers, mapper tests, and `up`/`down` migrations. Round 3 adds about 150 lines: SMTP and URL config (+30 in U2), the Nodemailer adapter and its Mailpit test (+100 in U4), and the extra routes (+20). Round 4 adds about 100 lines for the hosted forgot-password page: view, controller, and e2e (+90 in U9), the login link and its test (+10 in U7). Round 5 adds about 40-80 lines for the post-reset redirect URI: column, migration, value object, CLI flag, and tests (+30-55 in U3), redirect branch and e2e for both cases (+10-25 in U9). Round 6 adds about 80-120 lines for the container setup (U1b: Dockerfile, `.dockerignore`, `compose.yaml`, README section). The API versioning decision (ADR 28, `decisions-round6`) adds about 30-50 lines in U2: the `configureApp` function, the shared e2e factory, the prefix e2e test, and the welcome test update. Totals are now 4,900-6,770. |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | Welcome commit on `main` (no PR) -> PR U1b (into develop) -> PR U1 (after `develop` is merged into it) -> PR U2 -> ... -> PR U10, each targeting <=400 lines. Units forecast above 400 have pre-planned a/b split points. |
| Delivery strategy | ask-on-risk, resolved as chained PRs |
| Chain strategy | stacked-to-develop (base `develop`) |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-develop
400-line budget risk: High

> No decision is pending. Conflicts 1, 3, and 5 are resolved, and delivery and chain strategy are resolved. The 400-line budget risk remains High, so work follows the chained PRs. Apply can start at U1.

### Branch flow

```
main:    [welcome commit] ── (promotion to main is out of scope)
             \
develop:      ●── U1 ── U2 ── U3 ── ... ── U10      (each PR targets develop, merges in order)
```

Every feature or work-unit PR (U1b, U1, U2, ...) targets `develop`, never `main`; `main` only receives promotions from `develop`. The next unit branches from the updated `develop` only after the previous PR merges. If a diff shows earlier units, update it from `develop` before review (rebase if unpublished; merge `develop` in if the branch is already published).

### Suggested Work Units

| Unit | Goal | Est. lines | Depends on | Split point if over 400 |
|------|------|-----------:|------------|-------------------------|
| U1 | Bootstrap: TypeORM + pg scaffold, DataSource, test stack, config.yaml | 300 | welcome commit | - |
| U1b | Container setup: Dockerfile, `.dockerignore`, `compose.yaml` (api, postgres, mailpit), README section | 100 | welcome commit (branched from 047fff7, develop's tip; targets `develop`) | - |
| U2 | shared-kernel + platform (config incl. SMTP and base URL, TypeORM module, UoW, health, `api/v1` prefix via `configureApp`) | 520 | U1 | U2a kernel + config / U2b persistence + UoW + health + prefix |
| U3 | app-registry + CLI (incl. post-reset redirect URI) | 550 | U2 | U3a apps persistence + use cases / U3b CLI + CORS |
| U4 | transactional-email (outbox, worker, Nodemailer SMTP adapter, templates) | 650 | U2 | U4a outbox + worker / U4b SMTP adapter + renderer + templates |
| U5 | user-accounts (signup, confirm, resend) | 600 | U3, U4 | U5a persistence + hasher / U5b endpoints |
| U6 | token-lifecycle A: KeyStore, JWT issuer, JWKS | 350 | U2 | - |
| U7 | authorization-flow: authorize, login (with forgot-password link), code issue | 660 | U3, U5, U6 | U7a codes persistence + GET validation / U7b views + POST login |
| U8 | token-lifecycle B: code exchange, refresh, revoke | 600 | U7 | U8a code exchange / U8b refresh + revoke |
| U9 | GET /api/v1/me + password-management (incl. hosted forgot page, post-reset redirect) | 610 | U5, U8 | U9a /api/v1/me + forgot (API + page) / U9b reset + change |
| U10 | E2E suite, OpenAPI, perf gate, docs | 600 | all | U10a e2e / U10b OpenAPI + docs + perf |

The units run sequentially because there is a single writer. Sub-PRs (for example U5a and U5b) also target `develop` in order. Measure `additions + deletions` before you open each PR.

## Spec/Design conflicts (resolve before apply)

1. **RESOLVED (round 3).** Endpoint paths are now fixed in the specs and in the design route table: `GET /`, `GET /health`, `GET /.well-known/jwks.json`, `GET /api/v1/oauth/authorize`, `POST /api/v1/oauth/login`, `POST /api/v1/oauth/token` (`authorization_code` | `refresh_token`), `POST /api/v1/oauth/revoke`, `GET /api/v1/me`, `POST /api/v1/accounts/signup`, `GET /api/v1/accounts/confirm`, `POST /api/v1/accounts/resend-confirmation`, `GET /api/v1/password/forgot` (round 4), `POST /api/v1/password/forgot`, `GET /api/v1/password/reset`, `POST /api/v1/password/reset`, `POST /api/v1/password/change` (16 routes; the three root routes `GET /`, `GET /health`, `GET /.well-known/jwks.json` stay unprefixed, ADR 28). The login submit path is `/api/v1/oauth/login` (the earlier `POST /oauth/authorize` is dropped).
2. Refresh TTL 30d and auth code TTL 60s: consistent (both are spec assumptions; design adopts them). No conflict.
3. **RESOLVED (round 3).** Duplicate-signup notice email confirmed: identical HTTP response, plus an `account-exists` notice to the existing owner suggesting login or password reset, links from `AUTH_PUBLIC_BASE_URL`. Template added in U4 (task 4.5); spec and design updated.
4. Generic errors: spec requires generic and equivalent status/body. Design adds an OAuth `invalid_grant` 400 and `/api/v1/me` 401, and is silent on confidential-client auth failure (spec: "rejected"). Proposed: `invalid_client` 401 for it.
5. **RESOLVED (round 3).** No per-app link base. Links use the global `AUTH_PUBLIC_BASE_URL`; templates stay as files per `client_id`, and `apps.email_from` may override the from address. The transactional-email spec is amended.
6. Design ADR 11 adds a 72-byte password maximum that specs omit (min 8 only). Proposed: add a spec scenario in U5.
7. Design pre-publishes a `next` key in JWKS; spec says only current and previous. Compatible; add a JWKS scenario in U6.

Status: conflicts 1, 3, and 5 resolved. Conflicts 2, 4, 6, 7 have proposed handling inside the units and need no decision.

## Closed questions (round 3)

- argon2id vs bcrypt: bcrypt cost 12 confirmed (design ADR 10; argon2id recorded as rejected).
- SendGrid vs AWS SES: generic SMTP through Nodemailer (design ADR 17; vendor SDKs recorded as rejected).

## U1 Bootstrap (no TDD yet)

Steps 1.1-1.3 run directly on `main` and `develop` (no PR). Steps 1.4-1.9 run on `feat/u1-bootstrap` and become PR U1 into `develop`.

- [x] 1.1 `git init -b main`; add `.gitignore` (`node_modules`, `dist`, `.env`, `coverage`), `.nvmrc` (24), `.editorconfig`
- [x] 1.2 Welcome commit on `main`: minimal NestJS 11 app (`package.json` engines `>=24 <25`, `tsconfig.json`, `src/main.ts`, `src/app.module.ts`, `src/platform/welcome.controller.ts` with `GET /` returning `{ "message": "Welcome to the API" }`). Verify with a manual `curl`. Commit: `feat: add welcome endpoint`
- [x] 1.3 `git switch -c develop` from the welcome commit; then `git switch -c feat/u1-bootstrap` from `develop`
- [x] 1.4 Add `typeorm`, `@nestjs/typeorm`, `pg`, `zod` (`@nestjs/config` was dropped in U2 review; see ADR 20). Create `src/platform/persistence/typeorm.options.ts` (shared options, `synchronize: false`, `migrationsRun: false`, migrations glob) and `data-source.ts` (standalone `DataSource` for the CLI). Create an empty `migrations/` folder.
- [x] 1.5 npm scripts: `migration:generate`, `migration:create`, `migration:run`, `migration:revert` (all `-d` the CLI DataSource), `build`, `start`, `test`
- [x] 1.6 Add Jest with `@swc/jest` (decorator metadata enabled), `supertest`, and `@testcontainers/postgresql`. Create `jest.config.ts` and `test/support/postgres.ts`, which starts a container, initializes a TypeORM `DataSource`, runs `runMigrations()`, and exposes truncate and teardown helpers.
- [x] 1.7 Smoke tests: e2e `GET /` returns the welcome message (supertest), and an integration test boots Postgres and runs migrations (`SELECT 1`)
- [x] 1.8 Fix the `openspec/config.yaml` `apply:` block (it mixes a list item and mapping keys). Set `apply.tdd: true`, `apply.test_command: "npm test"`, `verify.test_command: "npm test"`, `verify.build_command: "npm run build"`, `strict_tdd: true`. Commit `openspec/` and `PRD-AUTH.md` in this PR.
- [x] 1.9 (Done: integration suite green with Docker running (2/2); build and unit/e2e green. No git remote yet, so PR U1 is pending a remote) Verify: `npm test` and `npm run build` are green. Commit: `chore: bootstrap typeorm, migrations cli and test stack`. Open PR U1 with base `develop`.

## U1b Container setup (separate small PR, lands before U1)

Branch `feat/u1b-docker` was branched from 047fff7, which is also the tip of `develop`, so no rebase is needed. The PR targets `develop` (never `main`). Merge order: U1b merges into `develop` first; then `develop` is merged into `feat/u1-bootstrap` with a merge commit, not a rebase, because that branch is already published; then PR U1 merges. Forecast: about 80-120 changed lines.

- [x] 1b.1 `Dockerfile`, multi-stage: build stage `node:24-alpine` (`npm ci`, `npm run build`); runtime stage `node:24-alpine` (`npm ci --omit=dev`, copy `dist/` only, `NODE_ENV=production`, non-root `node` user, `EXPOSE 3000`, `HEALTHCHECK` on `GET /` using node, `CMD ["node","dist/main.js"]`)
- [x] 1b.2 `.dockerignore`: `node_modules`, `dist`, `.git`, `openspec`, `.atl`, `coverage`, `test`, markdown docs, `.env*`
- [x] 1b.3 `compose.yaml` with `api` (built from the Dockerfile, port 3000, `PORT` and `DATABASE_URL`, `depends_on` postgres `service_healthy`), `postgres` (`postgres:17-alpine`, dev-only credentials, named volume, `pg_isready` healthcheck, port 5432), and `mailpit` (`axllent/mailpit`, ports 8025 UI and 1025 SMTP). The app does not connect to the DB yet; U2 wires it.
- [x] 1b.4 README: "Run locally with Docker" section (`docker compose up --build`, URLs, Node 24 + npm alternative)
- [x] 1b.5 Verify: `docker build`, `docker compose up -d --build`, `curl http://localhost:3000/` returns the welcome message, Mailpit UI answers on :8025, then `docker compose down -v`. Commit: `build: add dockerfile and compose for local development`.

## U2 Platform (RED -> GREEN -> REFACTOR per item)

- [x] 2.1 RED/GREEN: `src/shared-kernel/` Clock, TokenGenerator (>=32 bytes, SHA-256 hash), Result/DomainError, UnitOfWork port; tests
- [x] 2.2 RED/GREEN: `src/platform/config` zod schema (DB settings consumed by `typeorm.options.ts`, plus `AUTH_PUBLIC_BASE_URL`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`; `SMTP_USER`/`SMTP_PASS` both or neither), fail fast on invalid env; test
- [x] 2.3 RED/GREEN: `TypeOrmModule.forRootAsync` wiring plus the `TypeOrmUnitOfWork` adapter (`DataSource.transaction()` + AsyncLocalStorage `EntityManager`, plus a `currentManager()` helper for repositories); integration test for commit and rollback (Testcontainers)
- [x] 2.4 RED/GREEN: `GET /health` with a DB ping, e2e; REFACTOR module wiring. Commit: `feat(platform): add config, typeorm, uow, health`
- [x] 2.5 RED/GREEN/REFACTOR: API prefix (ADR 28). RED: an e2e test built on the shared factory asserting that `/api/v1/...` business routes resolve (for example `GET /api/v1/me` answers 401, not 404), that `GET /`, `GET /health`, and `GET /.well-known/jwks.json` stay at the root, and that the unprefixed business path (for example `GET /me`) returns 404. GREEN: `src/platform/configure-app.ts` exporting `configureApp(app)`, which calls `app.setGlobalPrefix('api/v1', { exclude: ['/', 'health', '.well-known/jwks.json'] })`; call it from `main.ts` and from the e2e factory `test/support/create-test-app.ts`. REFACTOR: update the existing welcome e2e test from U1 to build its app through the shared factory. Commit: `feat(platform): add api v1 global prefix`

## U3 app-registry

- [x] 3.1 RED: `AppSchema` (`EntitySchema<AppRow>`, including nullable `post_reset_redirect_uri text`) plus migration `CreateApps` with `down()` (the column is part of this create migration, since `apps` does not exist yet); integration test for unique `client_id`, for a null and a stored `post_reset_redirect_uri`, and for migration reversibility (up -> down -> up)
- [x] 3.2 GREEN: domain `App`, `AppRepository` port, `AppMapper` (round-trip unit test, including the null case), `TypeOrmAppRepository` implementing the port; register use case (public: no secret; confidential: secret shown once, hashed)
- [x] 3.2a RED/GREEN/REFACTOR: `PostResetRedirectUri` value object. Unit tests first: accepts `https://a.example/login`; rejects relative, `javascript:`, `ftp:`, userinfo, fragment, and `http://a.example`; accepts `http://localhost` and `http://127.0.0.1` only when `isProduction` is false and rejects them when true; null is allowed. REFACTOR: table-driven cases
- [x] 3.3 RED/GREEN: exact redirect URI match; unknown/inactive `client_id` generic invalid-client
- [x] 3.4 RED/GREEN: `src/cli.ts` nest-commander create/update/deactivate; e2e: app routes return 404
- [x] 3.4a RED/GREEN/REFACTOR: CLI `--post-reset-redirect-uri <url>` on create and update, plus `--clear-post-reset-redirect-uri` on update. Use cases validate through `PostResetRedirectUri` (`isProduction` from validated config) before persisting. Tests: valid value stored, omitted gives null, update and clear, invalid value rejected with nothing persisted, `NODE_ENV=production` rejects http localhost. REFACTOR: share the option parsing between create and update
- [ ] 3.5 RED/GREEN: per-app CORS middleware from `allowed_origins`. Commit: `feat(app-registry): add apps, cli, origin checks`
- [ ] 3.6 Container migrations: the distroless image has no npm or shell, so `npm run migration:run` cannot run inside it. Run the TypeORM CLI with the image's own node: `node_modules/typeorm/cli.js migration:run -d dist/platform/persistence/data-source.js`. Steps:
  - Confirm `typeorm` is a production dependency and that compiled migrations land in `dist/`.
  - Add a one-shot `migrate` service to `compose.yaml` that uses the same image, overrides the command to run the migrations, and depends on `postgres` being healthy.
  - Make `api` depend on `migrate` with `condition: service_completed_successfully`.
  - Keep `migrationsRun: false`, so the app never migrates on startup.
  - Document the `docker compose run --rm migrate` and revert commands in the README. The CLI (`node dist/cli.js`) runs the same way.
  - Verify: `docker compose up -d --build` creates the `apps` table (check it with `psql` in the postgres container), the api becomes healthy, and a second `up` is a no-op.
  - Commit: `build: run migrations in a one-shot compose service`

## U4 transactional-email

- [ ] 4.1 RED: `EmailOutboxSchema` plus migration `CreateEmailOutbox` with `down()`; `SKIP LOCKED` integration test (`setLock('pessimistic_write')` + `setOnLocked('skip_locked')`)
- [ ] 4.2 GREEN: `EmailOutbox` port, mapper, and TypeORM repository; `EmailSender` port plus an in-memory fake (captures messages); `TemplateRenderer` (escaped Handlebars, `templates/default`, per-`client_id` override)
- [ ] 4.3 RED/GREEN: `SmtpEmailSender` (Nodemailer `createTransport` from `SMTP_HOST/PORT/SECURE/USER/PASS`), from address `app.email_from ?? MAIL_FROM`; integration test against a Mailpit container (Testcontainers, `axllent/mailpit`) asserting delivery, from override, and no secrets in logs; add Mailpit helper to `test/support/`
- [ ] 4.4 GREEN: worker with backoff, payload purge, provider failure logged without secrets; link builder using `AUTH_PUBLIC_BASE_URL` (no per-app base)
- [ ] 4.5 Templates: confirmation, welcome, reset, password-changed, `account-exists` (duplicate-signup notice: says someone tried to register, suggests login or password reset, links to `${AUTH_PUBLIC_BASE_URL}/api/v1/password/forgot?client_id=...`, no token; confirmation link is `${AUTH_PUBLIC_BASE_URL}/api/v1/accounts/confirm?token=...`; reset link is `${AUTH_PUBLIC_BASE_URL}/api/v1/password/reset?token=...&client_id=...`). Test: no password, every link starts with `AUTH_PUBLIC_BASE_URL`, the `account-exists` link has the app's `client_id` and no token. Commit: `feat(email): add outbox, worker, templates`

## U5 user-accounts

- [ ] 5.1 RED: `UserSchema` and `OneTimeTokenSchema` plus migrations `CreateUsers` (`CREATE EXTENSION IF NOT EXISTS citext`, UNIQUE(app_id,email)) and `CreateOneTimeTokens`, each with `down()`; test for the same email across apps; reversibility test
- [ ] 5.2 GREEN: domain `User` and `OneTimeToken`, mappers with round-trip tests, TypeORM repositories implementing `UserRepository` and `OneTimeTokenRepository`
- [ ] 5.3 RED/GREEN: `PasswordHasher` bcrypt 12 (min 8 chars, max 72 bytes), dummy compare for timing
- [ ] 5.4 RED/GREEN: `POST /api/v1/accounts/signup`; duplicate gives identical response plus the `account-exists` notice email to the existing owner; invalid input validation
- [ ] 5.5 RED/GREEN: `GET /api/v1/accounts/confirm` (24h, single-use) plus welcome email; generic invalid-or-expired
- [ ] 5.6 RED/GREEN: `POST /api/v1/accounts/resend-confirmation` invalidates old tokens, identical response. Commit: `feat(accounts): add signup and confirmation`

## U6 token-lifecycle A

- [ ] 6.1 RED/GREEN: `KeyStore` JWK-set adapter (`active`, `next`, `retired`), fixed test key in `test/support/`
- [ ] 6.2 RED/GREEN: `AccessTokenIssuer` with `jose` (RS256, `kid`, iss/aud/sub/iat/exp 3600/jti, no roles)
- [ ] 6.3 RED/GREEN: `GET /.well-known/jwks.json` (served at the root, excluded from the prefix; max-age 300, public keys only, rotation overlap). Commit: `feat(tokens): add key store, issuer, jwks`

## U7 authorization-flow

- [ ] 7.1 RED: `AuthorizationCodeSchema` plus migration `CreateAuthorizationCodes` with `down()`; mapper round-trip test; TypeORM repository implementing `AuthorizationCodeRepository`; integration test
- [ ] 7.2 RED/GREEN: `GET /api/v1/oauth/authorize` validation (S256 only, `plain` and missing challenge rejected, no redirect on bad client/URI)
- [ ] 7.3 RED/GREEN: Handlebars login/signup views (the form posts to `/api/v1/oauth/login`), strict CSP, HMAC-signed params, CSRF double-submit
- [ ] 7.4 RED/GREEN: `POST /api/v1/oauth/login` issues hashed 60s code and redirects with `state`; identical generic failure for wrong password, unknown email, unconfirmed.
- [ ] 7.5 RED/GREEN: the login view links to `/api/v1/password/forgot?client_id=<client_id>` (view test asserts the link and the app's `client_id`). Commit: `feat(authz): add hosted login and code issuance`

## U8 token-lifecycle B

- [ ] 8.1 RED: `RefreshTokenSchema` plus migration `CreateRefreshTokens` with `down()`; mapper round-trip test; TypeORM repository implementing `RefreshTokenRepository` with a `findByHashForUpdate` that uses `setLock('pessimistic_write')`
- [ ] 8.2 RED/GREEN: `POST /api/v1/oauth/token` code exchange (`grant_type=authorization_code`; verifier, redirect, app binding, reuse, `client_secret_basic`); any other `grant_type` returns `unsupported_grant_type`
- [ ] 8.3 RED/GREEN: refresh rotation inside `UnitOfWork` with a row lock, reuse revokes family (concurrent-refresh integration test), 30d expiry, wrong app
- [ ] 8.4 RED/GREEN: `POST /api/v1/oauth/revoke` family revoke. Commit: `feat(tokens): add exchange, refresh rotation, revoke`

## U9 /api/v1/me and password-management

- [ ] 9.1 RED/GREEN: `GET /api/v1/me` with JWT guard (`aud` check, no internal fields, 401 generic)
- [ ] 9.2 RED/GREEN: `POST /api/v1/password/forgot` generic response; reset email only for confirmed accounts; CSRF check on form submits
- [ ] 9.3 RED: hosted forgot-password page tests. View test: `forgot.hbs` renders hidden `client_id` and CSRF token, no account-state wording. Controller e2e: `GET /api/v1/password/forgot?client_id=` returns 200 with strict CSP and CSRF cookie for an active app; unknown or inactive `client_id` returns the generic error page with no form
- [ ] 9.4 GREEN: `forgot.hbs` view and `GET /api/v1/password/forgot` controller (validates `client_id` through the app registry, reuses the CSP/CSRF middleware from U7); `POST /api/v1/password/forgot` renders the generic result page. REFACTOR: share layout and CSRF helper with the login and reset views
- [ ] 9.5 RED/GREEN e2e: submit for confirmed, unknown, and other-app-only emails gives identical status and body; missing CSRF is rejected with no email; the reset email link carries `client_id`
- [ ] 9.6 RED/GREEN: `GET /api/v1/password/reset?token=&client_id=` renders the hosted reset form (strict CSP, CSRF) without revealing token validity; `POST /api/v1/password/reset` (1h, single-use, superseded) revokes all app refresh tokens; a `client_id` that does not match the token's app gives the generic error; the success page is app-scoped
- [ ] 9.6a RED: e2e for the post-reset redirect. Case 1: app with `post_reset_redirect_uri` set; a valid reset returns 302 with `Location` exactly equal to the stored value (no added query, no token or email). Case 2: app with null; a valid reset returns 200 with the app-scoped confirmation page and no `Location`. Also: `redirect_uri`, `next`, and `return_to` in query or form are ignored; failed resets (invalid, expired, reused, `client_id` mismatch, weak password) never redirect
- [ ] 9.6b GREEN/REFACTOR: after a successful `POST /api/v1/password/reset`, read the app through `AppRepository` and answer 302 to `post_reset_redirect_uri`, or render the confirmation page when null; read no request input for the target. REFACTOR: extract the success-response choice into a small helper
- [ ] 9.7 RED/GREEN: `POST /api/v1/password/change` plus notice email. Commit: `feat(password): add forgot, reset, change`

## U10 Verification and docs

- [ ] 10.1 E2E: full PKCE flow, refresh replay, logout, two-app isolation, audience mismatch
- [ ] 10.2 E2E: anti-enumeration status/body equality and timing tolerance across all flows
- [ ] 10.3 Full migration chain test: run all migrations, revert all of them to an empty schema, then run them again
- [ ] 10.4 OpenAPI setup, `README` (including the migration runbook: `migration:run` / `migration:revert`), `.env.example` (with `AUTH_PUBLIC_BASE_URL` and all `SMTP_*` / `MAIL_FROM`, pointing at a local Mailpit), `ops:revoke-all` CLI command, login P95 load-test script
- [ ] 10.5 Verify the route table matches the design exactly (16 routes: 13 under `/api/v1`, 3 at the root) and no Phase 2-4 endpoints exist. Commit: `docs: add openapi, runbook, e2e coverage`

## Follow-ups (from U2 review, not scheduled in any unit above)

- [ ] F.1 Split liveness (`/live`) from readiness (`/health`) before any orchestrator deployment. Today the container HEALTHCHECK and `/health` conflate the two: a DB outage marks the container unhealthy, which would trigger restarts instead of just removing it from rotation.
- [ ] F.2 Support `_FILE`-suffixed env vars (e.g. `DATABASE_URL_FILE`, `SMTP_PASS_FILE`) so secrets can be loaded from mounted files, as ADR 20 states. Today config reads plain env vars only.
