# Design: Auth Service MVP (Phase 1)

## Technical Approach

The service is one NestJS 11 app on Node 24 (`engines: ">=24 <25"`, `.nvmrc: 24`) backed by PostgreSQL through **TypeORM**. It uses hexagonal modules named after the six capabilities in the proposal. The domain and application layers are plain TypeScript. Nest, TypeORM, bcrypt, jose, and Nodemailer live only in adapters and module wiring. TypeORM persistence models are `EntitySchema` definitions inside each module's `infrastructure/persistence/` folder, and explicit mappers translate them to and from plain domain models. The hosted login, forgot-password, and reset pages are server-rendered Handlebars. Tokens are RS256 JWTs signed through a `KeyStore` port and published at JWKS. Emails go through a PostgreSQL outbox, so response timing never depends on whether an account exists.

> Size note: this design exceeds the 800-word budget because the project is greenfield and every stack choice is decided here.

## Architecture Decisions (ADRs)

| # | Decision | Choice | Rejected alternatives | Rationale and tradeoff |
|---|----------|--------|-----------------------|------------------------|
| 1 | ORM | **TypeORM** (current major, `@nestjs/typeorm` + `pg`) on PostgreSQL. `synchronize: false` in every environment. | Prisma; Kysely with raw SQL | The user chose it (binding decision, round 2). It supports row locks natively (`setLock('pessimistic_write')`, `setOnLocked('skip_locked')`), so rotation and the outbox need no raw SQL. Migrations have a native `down()`. There is no generated-client build step. Tradeoffs: query-builder results are less strictly typed, decorator entities invite persistence leaking into the domain (ADR 22 mitigates this), and generated migrations need manual review. **Prisma, rejected**: it has the best type-safe generated client, a declarative schema, and strong DX. However, it has no native down migrations (each one needs a hand-written `down.sql`), it adds a client-generation step to build and CI, and it needs `$queryRaw` for `FOR UPDATE` / `SKIP LOCKED`. |
| 2 | Layering | Hexagonal modules: `domain/` → `application/` → `infrastructure/` + `http/` | Classic Nest layering (controller → service → repository) | Keeps the domain framework-free. Use cases are plain classes registered through `useFactory`, so the application layer has no `@Injectable`. Cost: more wiring code. |
| 3 | Folder naming | Screaming architecture, one top-level folder per capability | Folders by technical layer | The folders map 1:1 to the specs, which helps traceability and review. |
| 4 | HTTP platform | Express (Nest default) | Fastify | Its CSRF, cookie, and view middleware are mature. Fastify's speed gain is irrelevant next to bcrypt cost. |
| 5 | Hosted UI | **Server-rendered Handlebars** (`hbs`), no client JS, strict CSP. Views: login/signup, forgot-password, reset-password (plus generic result and error pages). | React SPA; Next.js | It is the smallest attack surface and needs no second build. The same engine renders emails. Tradeoff: basic UX, which the proposal accepts. |
| 6 | Authorize-request state | HMAC-signed hidden field carrying the validated authorize params, plus a double-submit CSRF cookie | `authorization_requests` table; Auth-domain SSO session cookie | It is stateless and needs no table. Per-app accounts make SSO across apps pointless. Tradeoff: no silent re-login. Refresh tokens provide session persistence. |
| 7 | JWT library | `jose` (Node 24 supports `require(esm)`) | `jsonwebtoken` | Native JWK export and KeyObject support make JWKS trivial. |
| 8 | Key management | `KeyStore` port. The adapter loads a JWK set (`active`, `next`, `retired`) from a secret mounted as an env var or file. | Keys stored in the DB; Vault SDK coupling | Secrets stay platform-agnostic (Vault, AWS Secrets Manager, or Cloud Run secrets). A DB dump never contains private keys. |
| 9 | Key rotation | Three steps: (1) publish `next` in JWKS ≥ JWKS cache TTL (5 min) before use; (2) promote it to `active`; (3) keep the old key verify-only for 1h access TTL + cache TTL, then remove it. Emergency rotation: rotate and revoke all refresh tokens (`ops:revoke-all`). | Rotating keys without overlap | No app ever sees an unknown `kid` during normal rotation. |
| 10 | Password hashing | **bcrypt cost 12** (`bcrypt` native, which runs on the libuv threadpool) behind a `PasswordHasher` port | argon2id (m=19 MiB, t=2, p=1); `bcryptjs` | Confirmed by the user (round 3) and honors the PRD and the proposal. Hashes are self-describing (`$2b$12$`), so a future algorithm change stays possible through rehash-on-login with no migration. **argon2id, rejected**: it is memory-hard and the stronger default on paper, but the user confirmed bcrypt cost 12, and the PRD already specifies bcrypt. `bcryptjs` would block the event loop. |
| 11 | bcrypt 72-byte limit | Reject passwords over **72 UTF-8 bytes** at validation (with min-length 8 checked in characters) | HMAC-SHA256 pre-hash; silent truncation | The rule is explicit and standard. Pre-hashing adds a nonstandard scheme and its pitfalls. |
| 12 | bcrypt CPU cost | `UV_THREADPOOL_SIZE` = number of cores, horizontal scaling, and a load-test gate on login P95 < 500ms. A dummy hash compare on unknown emails equalizes timing. | Lowering the cost | At about 250ms per hash, 1000 logins/s needs about 250 cores. That is a scaling problem, not a design one. Phase 2 rate limiting reduces the abuse load. |
| 13 | Opaque tokens | 256-bit random, base64url. Stored as **SHA-256** with a unique index. | bcrypt-hashed tokens; plaintext | High entropy makes a fast hash safe and allows O(1) lookup. Applies to refresh tokens, one-time tokens, auth codes, and client secrets. |
| 14 | Refresh rotation | Every use rotates the token within the same `family_id`. Presenting an already-rotated or revoked token revokes the **whole family**. The row is locked with `SELECT … FOR UPDATE`. | No reuse detection; a grace window for concurrent refresh | Follows the OAuth 2.0 Security BCP. Tradeoff: two tabs refreshing at once may log out. The pilot SDK should serialize refresh. |
| 15 | Migrations | **TypeORM migrations** in `src/platform/persistence/migrations/`, run through the CLI against a standalone `DataSource` (`data-source.ts`). Each migration is generated from the schemas, reviewed by hand, and **must implement `down()`**. A reversibility test runs up → down → up. The app never auto-runs migrations (`migrationsRun: false`). | Forward-only migrations; `synchronize: true` | Native `down()` meets the proposal's reversible-migrations requirement with no side-car SQL files. Migrations run as an explicit deploy step. |
| 16 | Transactions | `UnitOfWork` port, implemented with `DataSource.transaction()` and AsyncLocalStorage holding the transactional `EntityManager`. Repositories resolve the manager from ALS, falling back to the default manager. | Passing `tx` through use cases; `typeorm-transactional` | Keeps the domain and application layers free of TypeORM. The library alternative patches TypeORM internals and adds a dependency for about 40 lines of code. |
| 17 | Email transport | `EmailSender` port with one **Nodemailer SMTP adapter** (`SmtpEmailSender`), provider-agnostic. Config from env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, default `MAIL_FROM`; `apps.email_from` overrides the from address per app. Templates are rendered in-house with Handlebars. Link base is the global `AUTH_PUBLIC_BASE_URL` (see ADR 24). | SendGrid SDK; AWS SES SDK | User decision (round 3). **SendGrid and SES SDKs, rejected**: vendor lock-in, a provider SDK in the adapter layer, and hosting is undecided. Any SMTP relay (SendGrid, SES, Postmark, or a self-hosted server) works through the same adapter by changing env values only. Tradeoff: no provider-specific features (webhooks, templates, analytics); bounce handling is Phase 2 anyway. |
| 18 | Email delivery | `email_outbox` table written in the same transaction. A worker polls with `FOR UPDATE SKIP LOCKED`, retries with backoff, and purges the payload after sending. | Synchronous send; fire-and-forget | Equalizes timing (anti-enumeration), survives crashes, and needs no Redis. |
| 19 | App registry ops | `nest-commander` CLI (`src/cli.ts`) that reuses the application use cases. Confidential client secrets are shown once and stored hashed. | Admin HTTP API | The admin panel is Phase 3. A CLI keeps the attack surface at zero. |
| 20 | Config | A **zod** schema validated at boot (fail fast), exposed through a custom `APP_CONFIG` provider (no `@nestjs/config`). Secrets come only from env or mounted files. `.env.example` is for dev. | Hardcoded defaults; a direct Vault client; `@nestjs/config` | Twelve-factor, and portable across hosts. A custom provider is simpler, and `ConfigModule.validate` conflicts with the e2e config override. |
| 21 | Testing | Jest with `@swc/jest`, supertest e2e, and **Testcontainers** (`@testcontainers/postgresql`) with a TypeORM `DataSource`. Test setup runs all migrations. | `pg-mem` (partial Postgres: no `citext`, no `SKIP LOCKED` semantics); a shared docker-compose DB | Tests run against real Postgres semantics (row locks, `citext`) in isolated, reproducible runs, and migrations are exercised on every run. Cost: Docker is required locally and in CI. |
| 22 | Persistence models | `EntitySchema<XRow>` with plain `XRow` interfaces, plus an `XMapper` (`toDomain`, `toPersistence`) per aggregate. All of them live in `<module>/infrastructure/persistence/`. Repositories implement domain ports and return domain models only. | Decorated `@Entity` classes in infrastructure; decorating domain entities | No class anywhere carries ORM decorators, so a persistence class can never be mistaken for a domain one. Cost: mapper boilerplate, covered by round-trip unit tests. |
| 23 | Branching | `main` holds only the welcome commit. `develop` is branched from it. U1b and U1..U10 are **stacked-to-develop** chained PRs: every feature or work-unit PR targets `develop`, never `main`, and merges before the next one is opened. Branches that are already published receive `develop` by merge, not rebase. | Stacked to `main`; feature-branch chain with a tracker | User decision (round 2, reaffirmed round 6). `develop` integrates the feature, and `main` stays deployable. `main` only receives promotions from `develop`, which is out of scope. U1b merges into `develop` first, then `develop` is merged into `feat/u1-bootstrap`. |
| 24 | Email link base | One global env var `AUTH_PUBLIC_BASE_URL` (the public URL of the Auth host, validated as an absolute http(s) URL without trailing slash). Links are `${AUTH_PUBLIC_BASE_URL}/api/v1/accounts/confirm?token=...`, `${AUTH_PUBLIC_BASE_URL}/api/v1/password/reset?token=...&client_id=...`, and (for the `account-exists` notice) `${AUTH_PUBLIC_BASE_URL}/api/v1/password/forgot?client_id=...`. Nothing is stored per app. | Per-app link base column | User decision (round 3). Links must always target the Auth host, so a per-app value adds config risk (phishing via a misconfigured base) for no benefit. Resolves conflict 5. |
| 26 | Hosted forgot-password page | `GET /api/v1/password/forgot?client_id=` renders a Handlebars form. `client_id` is validated against the app registry (unknown or inactive gives the same generic error page as `/api/v1/oauth/authorize`, with no form). The form carries `client_id` as a hidden field plus the double-submit CSRF cookie token (same CSP and CSRF middleware as login and reset) and posts to the existing `POST /api/v1/password/forgot`. The response is always the same generic page. The reset email link is `${AUTH_PUBLIC_BASE_URL}/api/v1/password/reset?token=...&client_id=...`; the reset use case checks that `client_id` matches the token's app (mismatch gives the generic invalid-or-expired page). The post-reset success page is rendered for that app (per-`client_id` view override, else default). | A new `forgot_requests` table; carrying the signed authorize params; a per-app reset URL column | `client_id` is public and already the app key everywhere, so it needs no signing and no storage. Binding it into the reset link keeps both emails and the success page app-scoped while the token stays the only secret. The post-reset destination is covered by ADR 27. `POST` still returns the generic response for any syntactically valid body for a valid app, so no email enumeration is added. |
| 25 | Email test setup | **Mailpit via Testcontainers** for `SmtpEmailSender` integration tests (one container, asserts the real SMTP path through Mailpit's HTTP API). Unit and e2e tests use an in-memory fake `EmailSender` that captures messages. | Fake only; a shared docker-compose Mailpit | A fake cannot prove the SMTP wiring (TLS flags, auth, from override), and Testcontainers is already required for Postgres (ADR 21), so Mailpit adds no new tooling. Keeping e2e on the fake keeps those tests fast. Cost: one more container, started by two integration files (`smtp-email-sender` and `email-pipeline`, each with its own instance). The SMTP test proves delivery, the from override and that credentials are refused when the server offers no STARTTLS; it does not prove credential correctness or a TLS handshake (Mailpit accepts any login and runs without TLS here). |
| 27 | Post-reset redirect | Nullable column `apps.post_reset_redirect_uri text`. After a successful `POST /api/v1/password/reset`, the controller answers `302` to that stored value; when null it renders the existing app-scoped confirmation page. The value is validated by a pure `PostResetRedirectUri` value object in `app-registry/domain` (absolute URL; `https`, or `http` only for `localhost`/`127.0.0.1` when `NODE_ENV !== 'production'`; no userinfo, no fragment). The CLI create and update commands call it through the use cases (`--post-reset-redirect-uri`, and `--clear-post-reset-redirect-uri` on update). The reset flow reads the target only from the app record, never from query or form input, and appends nothing to it. | Reusing `redirect_uris` (OAuth list); accepting a `redirect_to` parameter checked against an allowlist; signing a redirect parameter; a global env var | User decision (round 5). The name states the purpose and keeps it apart from the OAuth `redirect_uris`, which must never double as a post-reset target. A fixed, operator-set target removes the open-redirect class entirely: there is no request input to validate or sign. Validation at write time (CLI) means the runtime path stays a plain read. The `NODE_ENV` rule lives in the app-registry use case, which receives `isProduction` as an input, so the domain stays pure and config stays in the platform module. Tradeoffs: one URL per app (no per-flow targets), and no `state` or `login_hint` is passed, so the SPA starts its normal login. No tokens or PII are carried, so nothing leaks through logs or referrers. |
| 28 | API versioning | **Global prefix `api/v1`**, set in U2 through `app.setGlobalPrefix('api/v1', { exclude: ['/', 'health', '.well-known/jwks.json'] })` inside a shared `configureApp(app)` function used by both `main.ts` and the e2e test app factory. Prefixed: `/me`, `/accounts/*`, `/password/*`, `/oauth/*` (including the hosted pages `GET /oauth/authorize`, `GET /password/forgot`, `GET /password/reset` and their form posts). Root, unprefixed: `GET /`, `GET /health`, `GET /.well-known/jwks.json` (RFC 8615 requires `.well-known` at the root). Email links: `${AUTH_PUBLIC_BASE_URL}/api/v1/accounts/confirm?token=...`, `/api/v1/password/reset?token=...&client_id=...`, `/api/v1/password/forgot?client_id=...`. | No versioning; NestJS URI versioning (`VersioningType.URI`, `@Controller({ version: '1' })`) per controller | User decision (round 6). A single prefix is one line of config, applies uniformly to every business route and view, and leaves a clear place for a future `/api/v2`. **No versioning, rejected**: the first breaking change would force a path migration for every pilot client with no escape hatch. **URI versioning per controller, rejected**: it adds a version decorator to every controller, makes it easy to forget one, and offers per-route versions that Phase 1 does not need. Sharing `configureApp` between `main.ts` and the e2e factory keeps tests on production routes. **Tradeoff**: if a v2 ever ships, the v1 hosted pages and email links must stay alive for as long as outstanding tokens are valid (confirmation 24h, reset 1h, refresh 30d for login redirects), because links already sent to users embed `/api/v1`. Root routes are version-agnostic by design, so health checks and JWKS discovery never change. |
| 29 | CORS origin allowlist | CORS allows a request's `Origin` when it exactly matches an entry in `allowed_origins` of **any active app**. `AppRepository.isOriginAllowed(origin)` runs one query (`status = 'active' AND $1 = ANY(allowed_origins)`); `IsOriginAllowedUseCase` caches answers in memory for 30 s (bounded, injected `Clock`). No `client_id` is read from query or body. Origins are validated and normalized at registration (`AllowedOrigin`); client ids are `app_` + 32 hex chars so they never parse as CLI options. | Per-app CORS keyed by `client_id` in query/body | CORS only tells the browser who may read a response; it is not authorization, so per-app isolation adds nothing. The per-app design forced SPAs to append `?client_id=` to every call (preflights have no body, `/me` has only a bearer) and cost one DB lookup per cross-origin request, which also let random `client_id`s hit the DB. Tradeoff: a deactivated app's origin stays allowed for up to the cache TTL. |
| 30 | Outbox worker and templates | The worker claims one email at a time under a **lease**: one short statement (`UPDATE email_outbox SET locked_until = now + 120 s WHERE id = (SELECT ... WHERE status = 'pending' AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`), so parallel workers never take the same email and nothing stays locked while it works. Rendering and sending run **outside any transaction** under an overall 60 s deadline (`Promise.race`, timer cleared); the deadline is shorter than the lease, so a live worker finishes first. The outcome (sent, retry or failed) is stored in its own short statement that clears `locked_until` and is **fenced** on `AND locked_until = <the claimed value>`: a worker that lost its lease cannot overwrite the new owner's result. Lease timestamps come from the app clock so they round-trip through a JS `Date` for that equality; instances need clocks within a few seconds. **Delivery is at-least-once**: a crash, or a send that outlives its lease (the deadline abandons the send, it cannot cancel it), can deliver the email again; a lost-lease outcome is discarded and logged. Provider or render failures retry with backoff (30 s doubling, capped at 1 h, 8 attempts); an unknown template, an invalid payload or a missing app fail at once. `sent` and `failed` rows get an empty payload, so a raw token never outlives delivery. Stored and logged error text is bounded (500 chars) and has the recipient and payload values masked case-insensitively. The payload holds only raw inputs (the token); links are built at send time from `AUTH_PUBLIC_BASE_URL`. Templates are files `templates/<default or client_id>/<name>.{subject,text}.hbs`, rendered on an isolated Handlebars instance in strict mode; both parts are plain text (not HTML-escaped, subject line breaks collapsed); there is no html part until a requirement asks for one; a `client_id` that is not a plain name is ignored. `SmtpEmailSender` refuses a recipient that is not one plain address (Nodemailer would send to every address in a list) and requires STARTTLS when credentials are set without implicit TLS; the same address rule validates an app's `email_from` at registration and update. **Shutdown**: the poller stops scheduling, the worker stops after the current email, and `onModuleDestroy` awaits the in-flight drain (bounded by the send deadline) before Nest closes the database; Compose gives the api a 70 s stop grace. **Capacity**: the pg pool is explicit (`extra.max` = 10, `DB_POOL_MAX`) and the poller runs one drain at a time, one email at a time, so it holds at most one connection and only for the short claim and completion statements; raising poller concurrency means more parallel drains, with the pool kept above drains plus expected parallel requests. The poller is started by `main.ts` only, so tests and the CLI never poll. | Holding a row lock in a transaction for the whole send (the first implementation); one transaction per batch; a `to` list | A transaction held across SMTP I/O left an idle-in-transaction connection with no overall bound (Nodemailer timeouts are per inactivity), serialized throughput behind provider latency, tied poller concurrency to the HTTP pool, and breaks under `idle_in_transaction_session_timeout` and PgBouncer transaction pooling. The lease costs one nullable column (folded into the unmerged migration) and one extra failure mode (an expired lease can allow a duplicate), which at-least-once delivery already accepts after a crash. |
| 31 | Account signup, confirmation and resend | Accounts are inserted with one `INSERT .. ON CONFLICT DO NOTHING` on `UNIQUE(app_id, email)` (`citext`, emails also normalized to lowercase), so a duplicate is detected atomically and two concurrent signups cannot both win. Signup validates input first (client, email, password: 8 characters, 72 UTF-8 bytes, no NUL), then **hashes the submitted password on every path** before inserting; a duplicate therefore costs the same bcrypt work as a new account, with no dummy hash needed. Inside one `UnitOfWork` it then writes either the account, a confirmation token (SHA-256, 24 h, superseding earlier ones) and a `confirmation` outbox row, or just an `account-exists` outbox row (no token). The HTTP answer is `202` with one fixed body for both. Confirmation consumes the token in a single `UPDATE .. WHERE consumed_at IS NULL AND expires_at > now RETURNING` (single use, race-safe), marks the email verified and queues `welcome` in the same transaction (the mark is a targeted `UPDATE users SET email_verified_at .. WHERE id = $1 AND email_verified_at IS NULL`, never a whole-row save, so a password change committed meanwhile is not overwritten); every failure (malformed, unknown, used, expired) answers `400 invalid_or_expired_link`. Resend answers `202` with one body for unknown, unconfirmed and confirmed accounts. Unknown or inactive `client_id` answers `400 invalid_client` (it is a public identifier; unknown and inactive apps are indistinguishable, as in `ResolveClientUseCase`). bcrypt runs through its async API (libuv threadpool). **No CORS** on `/api/v1/accounts/*` (signup, confirm, resend): they are reached through the hosted UI or app backends, not browser SPAs. Enabling CORS there would let any registered origin drive signup and resend from browsers (email bombing, enumeration timing) for no benefit; revisit it only with a product requirement for SPA-native signup, together with rate limiting. | Dummy-hash compare on the duplicate path; read-then-insert duplicate check; sending email inline; deferring the whole resend to the worker | A dummy hash is a second code path to keep equal to the real one; hashing the real password on both paths makes the equality structural. A read-then-insert check races. Residuals, all **accepted for Phase 1** and revisited with Phase 2 rate limiting: (1) resend does a few more writes for an unconfirmed account than for an unknown one (milliseconds, with no hash to mask it); this timing gap is explicitly ACCEPTED until Phase 2 rate limiting; (2) the new-account signup path does one CSPRNG call, one UPDATE and two INSERTs more than the duplicate path, roughly 3-10 ms against about 250 ms for the bcrypt hash both paths share; (3) a duplicate signup floods the owner's inbox. |
| 32 | Signing key delivery (U6) | The key set is one JSON secret: `{ "active": <private JWK>, "next": <private JWK>?, "retired": [<JWK>...]? }`, each with a `kid` (`[A-Za-z0-9_-]{1,64}`), RSA >= 2048 bits. It comes from `AUTH_SIGNING_KEYS` (inline) or `AUTH_SIGNING_KEYS_FILE` (mounted file); exactly one must be set. `JwkSetKeyStore.fromJson` runs at boot and refuses to start on invalid JSON, a missing or mismatched private key (sign/verify self-test on `active` and `next`), a duplicate `kid` or a short key; messages carry slot and rule names only, never key material. JWKS publishes `active`, `next` and `retired` as allow-listed public fields (`kty n e kid alg use`), so private parameters cannot leak by construction. Dev: `npm run keys:generate` writes a gitignored `.keys/signing-keys.json`; compose runs a one-shot `keygen` service that creates one in a named volume (`down -v` discards it). The issuer URL is `AUTH_PUBLIC_BASE_URL` (no new variable). Tokens are signed and verified with `jose` behind the `AccessTokenIssuer` and `AccessTokenVerifier` ports (domain has no `jose` import). The verifier builds its key lookup from the published JWKS only, pins `RS256` itself (not just through the JWKS `alg` hint), requires a `kid`, caps the token at 4096 characters, allows 5 s of clock skew and returns one generic `invalid_token` error. | Keys in the DB (ADR 8); a committed dev key; generating a key in memory at every boot | A committed key would eventually be trusted somewhere, and per-boot keys break multi-instance and restarts. **Rotation** is a config change: add `next`, wait for the JWKS cache TTL, then move `next` to `active` and `active` to `retired`, and drop `retired` after 1h + cache TTL (ADR 9). Tradeoff: rotation needs a redeploy or restart; there is no hot reload in Phase 1. |

## Module Structure

Paths below are shown with the `/api/v1` prefix except the three root routes (ADR 28).

```
src/
  app-registry/        domain/ application/ infrastructure/{persistence,cli} http/ app-registry.module.ts
  user-accounts/       (POST /api/v1/accounts/signup, GET /api/v1/accounts/confirm, POST /api/v1/accounts/resend-confirmation, GET /api/v1/me)
  authorization-flow/  (GET /api/v1/oauth/authorize, POST /api/v1/oauth/login, hosted login view)
  token-lifecycle/     (POST /api/v1/oauth/token, POST /api/v1/oauth/revoke, GET /.well-known/jwks.json at the root)
  password-management/ (GET+POST /api/v1/password/forgot, GET+POST /api/v1/password/reset, POST /api/v1/password/change, hosted forgot and reset views)
  transactional-email/ (outbox, worker, renderer, SmtpEmailSender, templates/{default,<client_id>}/)
  shared-kernel/       (Clock, RandomToken, Result/DomainError, UnitOfWork port)
  platform/            welcome.controller.ts (GET /), config, health, csrf, cors, openapi,
                       configure-app.ts (global prefix, shared by main.ts and the e2e factory),
                       persistence/{typeorm.options.ts, data-source.ts, typeorm-unit-of-work.ts, migrations/}
  main.ts  cli.ts
test/e2e/  test/support/ (testcontainers + migrated DataSource, fakes, fixed RSA key, createTestApp factory)
```

**Bootstrap note (ADR 28):** the prefix lives in one shared function, `configureApp(app)` in `platform/configure-app.ts`. Both `main.ts` and the e2e test app factory (`test/support/create-test-app.ts`) call it right after `NestFactory.create` / `Test.createTestingModule(...).createNestApplication()`. E2E tests therefore hit the production route layout, and no test can pass on a path that production does not serve.

`typeorm.options.ts` builds one options object from validated config. Both `TypeOrmModule.forRootAsync` and the CLI `data-source.ts` use it, so the app and the migrations never drift. Each module registers its own schemas with `TypeOrmModule.forFeature`.

**Module notes (ADR 27):** `app-registry/domain` owns the `PostResetRedirectUri`, `AllowedOrigin` and `AppRedirectUri` value objects (pure, no Nest or config imports; origins are normalized, redirect URIs kept verbatim, and both reuse the `isProduction` rule). The register and update use cases take an `isProduction` flag from the CLI composition root, which reads `NODE_ENV` from validated config. `password-management` depends on the existing `AppRepository` port only, so it needs no new port.

**Ports (in domain):** `AppRepository`, `UserRepository`, `RefreshTokenRepository`, `OneTimeTokenRepository`, `AuthorizationCodeRepository`, `PasswordHasher`, `AccessTokenIssuer`, `KeyStore`, `EmailOutbox`, `EmailSender`, `TemplateRenderer`, `Clock`, `TokenGenerator`, `UnitOfWork`.

## Data Model

Each table is defined by an `EntitySchema` and created by a migration with `down()`. Column mappings are `bytea` → `Buffer`, `text[]` → `type: 'text', array: true`, and enums → Postgres enum types. The `users` migration runs `CREATE EXTENSION IF NOT EXISTS citext`.

| Table | Key columns |
|-------|-------------|
| `apps` | `id uuid`, `client_id text UNIQUE`, `name`, `client_type enum(public, confidential)`, `client_secret_hash bytea NULL`, `redirect_uris text[]` (exact match), `allowed_origins text[]`, `email_from`, `post_reset_redirect_uri text NULL`, `status`, timestamps |
| `users` | `id uuid`, `app_id FK`, `email citext`, `password_hash`, `email_verified_at NULL`, `password_changed_at`, timestamps, **UNIQUE(app_id, email)** |
| `refresh_tokens` | `id`, `user_id FK`, `app_id FK`, `family_id uuid` (indexed), `token_hash bytea UNIQUE`, `replaced_by_id NULL`, `expires_at` (30d), `revoked_at NULL`, `revoked_reason`, `created_at` |
| `one_time_tokens` | `id`, `user_id FK`, `purpose enum(email_verification, password_reset)`, `token_hash bytea UNIQUE`, `expires_at` (24h or 1h), `consumed_at NULL`. Issuing a new token invalidates earlier unconsumed ones for the same purpose. |
| `authorization_codes` | `code_hash bytea PK`, `app_id`, `user_id`, `redirect_uri`, `code_challenge`, `method = 'S256'` only, `expires_at` (60s), `consumed_at NULL` |
| `email_outbox` | `id`, `app_id FK`, `to_address` (`to` is a reserved word), `template`, `payload jsonb`, `status enum(pending, sent, failed)`, `attempts`, `next_attempt_at`, `last_error`, `locked_until` (lease expiry, null when unclaimed), `created_at`. Partial index on `next_attempt_at` where `status = 'pending'`. |

## Data Flow

**Authorization Code + PKCE**

```
SPA            Auth (hosted UI)                 DB
 |-- GET /api/v1/oauth/authorize?client_id,redirect_uri,
 |   code_challenge(S256),state ------------>| validate app + exact redirect_uri
 |<-- login form (signed params + CSRF) -----|
 |-- POST /api/v1/oauth/login (credentials) ->| user by (app_id,email); bcrypt verify
 |                                           |-- insert code_hash (60s) -->|
 |<-- 302 redirect_uri?code&state -----------|
 |-- POST /api/v1/oauth/token code+verifier ->| consume code, check S256(verifier)
 |<-- access JWT (1h) + refresh (30d) -------|-- insert refresh(family) -->|
```

**Refresh rotation**

```
client -- POST /api/v1/oauth/token grant=refresh_token --> lock row by hash (pessimistic_write)
  active   -> mark replaced, insert new (same family) -> new pair
  rotated/revoked -> revoke family -> 400 invalid_grant (generic)
```

**Post-reset redirect (ADR 27)**

```
user -- POST /api/v1/password/reset (token, client_id, new password, CSRF) --> Auth
  invalid/expired/mismatch/weak -> generic error or validation page (no redirect)
  success -> app = registry.get(token.app) ; revoke refresh families
     app.post_reset_redirect_uri set  -> 302 Location: <stored value, unchanged>
     null                             -> 200 app-scoped confirmation page
```

**Persistence path:** use case → port → TypeORM repository (manager from ALS) → `EntitySchema` row → mapper → domain model.

Logout calls `/api/v1/oauth/revoke`, which revokes the family. A password change or reset revokes every family the user has in that app.

## Interfaces / Contracts

```ts
// Access JWT: header { alg: 'RS256', kid }
interface AccessTokenClaims { iss: string; sub: string; aud: string /* client_id */; iat: number; exp: number; jti: string; }
interface KeyStore { activeSigningKey(): SigningKey; publicJwks(): JsonWebKeySet; }
interface PasswordHasher { hash(p: string): Promise<string>; verify(p: string, h: string): Promise<boolean>; needsRehash(h: string): boolean; }

// infrastructure/persistence only
interface AppRow { id: string; client_id: string; client_secret_hash: Buffer | null; redirect_uris: string[]; post_reset_redirect_uri: string | null; /* ... */ }
const AppSchema = new EntitySchema<AppRow>({ name: 'App', tableName: 'apps', columns: { /* ... */ } });
const AppMapper = { toDomain(row: AppRow): App { /* ... */ }, toPersistence(app: App): AppRow { /* ... */ } };
```

**Route table** (resolves conflict 1):

| Method + path | Module | Purpose |
|---------------|--------|---------|
| `GET /` | platform | Welcome message |
| `GET /health` | platform | Liveness plus DB ping |
| `GET /.well-known/jwks.json` | token-lifecycle | Public keys |
| `GET /api/v1/oauth/authorize` | authorization-flow | Validates the request and renders the hosted login |
| `POST /api/v1/oauth/login` | authorization-flow | Form submit; on success `302` to `redirect_uri?code&state` |
| `POST /api/v1/oauth/token` | token-lifecycle | `grant_type=authorization_code` or `refresh_token`; others get `unsupported_grant_type` |
| `POST /api/v1/oauth/revoke` | token-lifecycle | Revokes the refresh token family |
| `GET /api/v1/me` | user-accounts | Profile for the access token |
| `POST /api/v1/accounts/signup` | user-accounts | Registration |
| `GET /api/v1/accounts/confirm?token=` | user-accounts | Email confirmation |
| `POST /api/v1/accounts/resend-confirmation` | user-accounts | New confirmation token |
| `GET /api/v1/password/forgot?client_id=` | password-management | Hosted forgot-password form (validated `client_id`, CSRF, strict CSP) |
| `POST /api/v1/password/forgot` | password-management | Generic response, reset email if confirmed |
| `GET /api/v1/password/reset?token=&client_id=` | password-management | Hosted reset form |
| `POST /api/v1/password/reset` | password-management | Sets the new password; `302` to the app's `post_reset_redirect_uri`, or the confirmation page when null (ADR 27) |
| `POST /api/v1/password/change` | password-management | Authenticated change |

The route table has 16 routes: 13 under `/api/v1` and 3 at the root (`GET /`, `GET /health`, `GET /.well-known/jwks.json`, per ADR 28). The hosted login form posts to `/api/v1/oauth/login` carrying the HMAC-signed authorize params and the CSRF token, and links to `GET /api/v1/password/forgot?client_id=...`. The earlier `POST /oauth/authorize` path is dropped.

**Config schema (zod)** adds: `AUTH_PUBLIC_BASE_URL` (required, absolute URL), `SMTP_HOST` (required), `SMTP_PORT` (number, default 587), `SMTP_SECURE` (boolean, default false; true means implicit TLS, usually port 465), `SMTP_USER` and `SMTP_PASS` (optional pair, both or neither, so a local catcher needs no auth), and `MAIL_FROM` (required default sender). `SMTP_PASS` is never logged.

```ts
interface EmailMessage { to: string; from: string; subject: string; text: string; }
interface EmailSender { send(message: EmailMessage): Promise<void>; } // SmtpEmailSender wraps nodemailer.createTransport
```

The outbox worker resolves `from` as `app.email_from ?? MAIL_FROM` and builds links from `AUTH_PUBLIC_BASE_URL`.

`GET /` returns `200 { "message": "Welcome to the API" }`. `GET /.well-known/jwks.json` returns `Cache-Control: public, max-age=300`. Confidential clients authenticate with `client_secret_basic`. Every client must use PKCE. CORS on `/api/v1/oauth/token`, `/api/v1/oauth/revoke`, and `/api/v1/me` allows a request's `Origin` when it exactly matches `allowed_origins` of any active app (ADR 29); it needs no `client_id`, so preflight and bearer-only calls work.

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Entities, PKCE verification, rotation and reuse rules, use cases, mapper round-trips | Jest with in-memory port fakes and a fixed `Clock` |
| Integration | TypeORM repositories, UnitOfWork, row locks, outbox `SKIP LOCKED`, migration reversibility (up → down → up), `SmtpEmailSender` (ADR 25) | Testcontainers Postgres, `DataSource.runMigrations()` in setup, truncation between tests; Testcontainers Mailpit (`axllent/mailpit`, SMTP 1025, HTTP API 8025) for the SMTP adapter |
| E2E | Full PKCE flow, refresh and reuse, verify, reset, anti-enumeration, `GET /`, prefix layout (ADR 28) | supertest on the Nest app built by the shared `configureApp` factory, a fake `EmailSender` that captures links, a fixed test RSA key |

U1 installs the runner (`npm test`). Then `openspec/config.yaml` is updated to `tdd: true` with `test_command`, and **strict TDD applies to every later task**.

## Migration / Rollout

TypeORM migrations create the schema (`npm run migration:run`), and the deploy pipeline runs them before the app starts. Rollback is `npm run migration:revert`, which reverts one migration per run through its `down()`. The pilot app switches to PKCE behind its own feature flag. The rollback is to turn the flag off and revert the migrations. If a key is compromised, follow ADR 9's emergency path.

Branch flow (ADR 23): `main` (welcome commit) → `develop` → PR U1b, PR U1 … PR U10, each one targeting and merged into `develop` in order (U1b first, then `develop` is merged into `feat/u1-bootstrap`). Nothing targets `main` except promotions from `develop`.

## Open Questions

No open questions remain. Closed in round 3:

- argon2id vs bcrypt: bcrypt cost 12 confirmed (ADR 10).
- SendGrid vs SES: generic SMTP via Nodemailer (ADR 17). Hosting target no longer affects the email choice.
- Duplicate-signup notice (conflict 3): a duplicate signup returns the same response as a successful one, and the existing owner gets the `account-exists` template ("signup attempt" notice). The template says someone tried to register with this address, suggests logging in or resetting the password, and carries no token. Any link in it is built from `AUTH_PUBLIC_BASE_URL`. Revised in round 4: Phase 1 now includes the hosted forgot-password page (ADR 26), so the template deep-links to `${AUTH_PUBLIC_BASE_URL}/api/v1/password/forgot?client_id=...` (still no token). The email is queued through the outbox in the same transaction as a normal signup, so timing matches.
