# Design: Auth Service MVP (Phase 1)

## Technical Approach

The service is one NestJS 11 app on Node 24 (`engines: ">=24 <25"`, `.nvmrc: 24`) backed by PostgreSQL through **TypeORM**. It uses hexagonal modules named after the six capabilities in the proposal. The domain and application layers are plain TypeScript. Nest, TypeORM, bcrypt, jose, and Nodemailer live only in adapters and module wiring. TypeORM persistence models are `EntitySchema` definitions inside each module's `infrastructure/persistence/` folder, and explicit mappers translate them to and from plain domain models. Tokens are RS256 JWTs signed through a `KeyStore` port and published at JWKS. Emails go through a PostgreSQL outbox, so response timing never depends on whether an account exists.

**Revision 2 (2026-10-05, API-only).** Auth serves no pages. App frontends call JSON endpoints directly with their `client_id`: `POST /api/v1/auth/login` returns an access token and an opaque refresh token in the body (ADR 34, 35). Postgres counters rate-limit and lock out before bcrypt runs (ADR 36, 37). CORS origins are bound to the calling app (ADR 38). Email links point to per-app URLs with the token in the fragment (ADR 39). U1–U6 are built and merged and stay valid; the hosted-UI and PKCE decisions are marked superseded below, not deleted. Read **Revision 2 ADRs** first.

**Revision 3 (2026-10-05, contract amendment, round 11).** Closes the gaps found while writing `docs/api-contract.md`: ADR 35 gains a refresh reuse grace window (about 10 s, same client IP), ADR 36 gains `refresh_ip` and `confirm_ip` limits, ADR 38 fixes origin-mismatch outcomes and preflight headers, ADR 39 requires email URL origins to be allowed origins, and the new ADR 43 fixes the shared response rules (error body, `/me` fields, change-password error, forgot for unconfirmed accounts, issuer and JWKS URL).

> Size note: this design exceeds the 800-word budget because the project is greenfield and every stack choice is decided here.

## Architecture Decisions (ADRs)

| # | Decision | Choice | Rejected alternatives | Rationale and tradeoff |
|---|----------|--------|-----------------------|------------------------|
| 1 | ORM | **TypeORM** (current major, `@nestjs/typeorm` + `pg`) on PostgreSQL. `synchronize: false` in every environment. | Prisma; Kysely with raw SQL | The user chose it (binding decision, round 2). It supports row locks natively (`setLock('pessimistic_write')`, `setOnLocked('skip_locked')`), so rotation and the outbox need no raw SQL. Migrations have a native `down()`. There is no generated-client build step. Tradeoffs: query-builder results are less strictly typed, decorator entities invite persistence leaking into the domain (ADR 22 mitigates this), and generated migrations need manual review. **Prisma, rejected**: it has the best type-safe generated client, a declarative schema, and strong DX. However, it has no native down migrations (each one needs a hand-written `down.sql`), it adds a client-generation step to build and CI, and it needs `$queryRaw` for `FOR UPDATE` / `SKIP LOCKED`. |
| 2 | Layering | Hexagonal modules: `domain/` → `application/` → `infrastructure/` + `http/` | Classic Nest layering (controller → service → repository) | Keeps the domain framework-free. Use cases are plain classes registered through `useFactory`, so the application layer has no `@Injectable`. Cost: more wiring code. |
| 3 | Folder naming | Screaming architecture, one top-level folder per capability | Folders by technical layer | The folders map 1:1 to the specs, which helps traceability and review. |
| 4 | HTTP platform | Express (Nest default) | Fastify | Mature middleware and a well-defined `trust proxy` model (ADR 37). Fastify's speed gain is irrelevant next to bcrypt cost. |
| 5 | Hosted UI | **Superseded by ADR 34 and ADR 41.** Was: server-rendered Handlebars login, forgot and reset pages. | — | Auth serves no pages (round 8). |
| 6 | Authorize-request state | **Superseded by ADR 34.** Was: HMAC-signed hidden field plus double-submit CSRF cookie for the hosted login. | — | No hosted login, so no login state or CSRF cookie. |
| 7 | JWT library | `jose` (Node 24 supports `require(esm)`) | `jsonwebtoken` | Native JWK export and KeyObject support make JWKS trivial. |
| 8 | Key management | `KeyStore` port. The adapter loads a JWK set (`active`, `next`, `retired`) from a secret mounted as an env var or file. | Keys stored in the DB; Vault SDK coupling | Secrets stay platform-agnostic (Vault, AWS Secrets Manager, or Cloud Run secrets). A DB dump never contains private keys. |
| 9 | Key rotation | Three steps: (1) publish `next` in JWKS ≥ JWKS cache TTL (5 min) before use; (2) promote it to `active`; (3) keep the old key verify-only for 1h access TTL + cache TTL, then remove it. Emergency rotation: rotate and revoke all refresh tokens (`ops:revoke-all`). | Rotating keys without overlap | No app ever sees an unknown `kid` during normal rotation. |
| 10 | Password hashing | **bcrypt cost 12** (`bcrypt` native, which runs on the libuv threadpool) behind a `PasswordHasher` port | argon2id (m=19 MiB, t=2, p=1); `bcryptjs` | Confirmed by the user (round 3) and honors the PRD and the proposal. Hashes are self-describing (`$2b$12$`), so a future algorithm change stays possible through rehash-on-login with no migration. **argon2id, rejected**: it is memory-hard and the stronger default on paper, but the user confirmed bcrypt cost 12, and the PRD already specifies bcrypt. `bcryptjs` would block the event loop. |
| 11 | bcrypt 72-byte limit | Reject passwords over **72 UTF-8 bytes** at validation (with min-length 8 checked in characters) | HMAC-SHA256 pre-hash; silent truncation | The rule is explicit and standard. Pre-hashing adds a nonstandard scheme and its pitfalls. |
| 12 | bcrypt CPU cost | `UV_THREADPOOL_SIZE` = number of cores, horizontal scaling, and a load-test gate on login P95 < 500ms. A dummy hash compare on unknown emails equalizes timing. | Lowering the cost | At about 250ms per hash, 1000 logins/s needs about 250 cores. That is a scaling problem, not a design one. Phase 1 limits run before bcrypt (ADR 36), so abusive traffic does not reach the hash. |
| 13 | Opaque tokens | 256-bit random, base64url. Stored as **SHA-256** with a unique index. | bcrypt-hashed tokens; plaintext | High entropy makes a fast hash safe and allows O(1) lookup. Applies to refresh tokens, one-time tokens, and client secrets. |
| 14 | Refresh rotation | **Superseded by ADR 35.** Was: rotation with `SELECT … FOR UPDATE` on a `family_id` column. | — | Replaced by an atomic `UPDATE … RETURNING` consume and a session table. |
| 15 | Migrations | **TypeORM migrations** in `src/platform/persistence/migrations/`, run through the CLI against a standalone `DataSource` (`data-source.ts`). Each migration is generated from the schemas, reviewed by hand, and **must implement `down()`**. A reversibility test runs up → down → up. The app never auto-runs migrations (`migrationsRun: false`). | Forward-only migrations; `synchronize: true` | Native `down()` meets the proposal's reversible-migrations requirement with no side-car SQL files. Migrations run as an explicit deploy step. |
| 16 | Transactions | `UnitOfWork` port, implemented with `DataSource.transaction()` and AsyncLocalStorage holding the transactional `EntityManager`. Repositories resolve the manager from ALS, falling back to the default manager. | Passing `tx` through use cases; `typeorm-transactional` | Keeps the domain and application layers free of TypeORM. The library alternative patches TypeORM internals and adds a dependency for about 40 lines of code. |
| 17 | Email transport | `EmailSender` port with one **Nodemailer SMTP adapter** (`SmtpEmailSender`), provider-agnostic. Config from env: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, default `MAIL_FROM`; `apps.email_from` overrides the from address per app. Templates are rendered in-house with Handlebars. Links come from per-app URLs (ADR 39, which supersedes ADR 24). | SendGrid SDK; AWS SES SDK | User decision (round 3). **SendGrid and SES SDKs, rejected**: vendor lock-in, a provider SDK in the adapter layer, and hosting is undecided. Any SMTP relay (SendGrid, SES, Postmark, or a self-hosted server) works through the same adapter by changing env values only. Tradeoff: no provider-specific features (webhooks, templates, analytics); bounce handling is Phase 2 anyway. |
| 18 | Email delivery | `email_outbox` table written in the same transaction. A worker polls with `FOR UPDATE SKIP LOCKED`, retries with backoff, and purges the payload after sending. | Synchronous send; fire-and-forget | Equalizes timing (anti-enumeration), survives crashes, and needs no Redis. |
| 19 | App registry ops | `nest-commander` CLI (`src/cli.ts`) that reuses the application use cases. Confidential client secrets are shown once and stored hashed. | Admin HTTP API | The admin panel is Phase 3. A CLI keeps the attack surface at zero. |
| 20 | Config | A **zod** schema validated at boot (fail fast), exposed through a custom `APP_CONFIG` provider (no `@nestjs/config`). Secrets come only from env or mounted files. `.env.example` is for dev. | Hardcoded defaults; a direct Vault client; `@nestjs/config` | Twelve-factor, and portable across hosts. A custom provider is simpler, and `ConfigModule.validate` conflicts with the e2e config override. |
| 21 | Testing | Jest with `@swc/jest`, supertest e2e, and **Testcontainers** (`@testcontainers/postgresql`) with a TypeORM `DataSource`. Test setup runs all migrations. | `pg-mem` (partial Postgres: no `citext`, no `SKIP LOCKED` semantics); a shared docker-compose DB | Tests run against real Postgres semantics (row locks, `citext`) in isolated, reproducible runs, and migrations are exercised on every run. Cost: Docker is required locally and in CI. |
| 22 | Persistence models | `EntitySchema<XRow>` with plain `XRow` interfaces, plus an `XMapper` (`toDomain`, `toPersistence`) per aggregate. All of them live in `<module>/infrastructure/persistence/`. Repositories implement domain ports and return domain models only. | Decorated `@Entity` classes in infrastructure; decorating domain entities | No class anywhere carries ORM decorators, so a persistence class can never be mistaken for a domain one. Cost: mapper boilerplate, covered by round-trip unit tests. |
| 23 | Branching | `main` holds only the welcome commit. `develop` is branched from it. U1b and U1..U10 are **stacked-to-develop** chained PRs: every feature or work-unit PR targets `develop`, never `main`, and merges before the next one is opened. Branches that are already published receive `develop` by merge, not rebase. | Stacked to `main`; feature-branch chain with a tracker | User decision (round 2, reaffirmed round 6). `develop` integrates the feature, and `main` stays deployable. `main` only receives promotions from `develop`, which is out of scope. U1b merges into `develop` first, then `develop` is merged into `feat/u1-bootstrap`. |
| 24 | Email link base | **Superseded by ADR 39.** Was: every link built from the global `AUTH_PUBLIC_BASE_URL` and pointing at Auth pages. `AUTH_PUBLIC_BASE_URL` now only sets the JWT issuer. | — | Auth has no pages to link to; links go to per-app URLs (round 10). |
| 26 | Hosted forgot-password page | **Superseded by ADR 34 and ADR 39.** Was: a hosted `GET /password/forgot?client_id=` Handlebars form. Kept idea: the reset token stays bound to the app of `client_id` (ADR 39). | — | No pages; apps build their own forgot form and call `POST /password/forgot`. |
| 25 | Email test setup | **Mailpit via Testcontainers** for `SmtpEmailSender` integration tests (one container, asserts the real SMTP path through Mailpit's HTTP API). Unit and e2e tests use an in-memory fake `EmailSender` that captures messages. | Fake only; a shared docker-compose Mailpit | A fake cannot prove the SMTP wiring (TLS flags, auth, from override), and Testcontainers is already required for Postgres (ADR 21), so Mailpit adds no new tooling. Keeping e2e on the fake keeps those tests fast. Cost: one more container, started by two integration files (`smtp-email-sender` and `email-pipeline`, each with its own instance). The SMTP test proves delivery, the from override and that credentials are refused when the server offers no STARTTLS; it does not prove credential correctness or a TLS handshake (Mailpit accepts any login and runs without TLS here). |
| 27 | Post-reset redirect | **Superseded by ADR 39.** Was: nullable `apps.post_reset_redirect_uri` and a `302` after reset. The column is dropped; its value object becomes `AppUrl`. Kept idea: URLs are operator-set and validated at write time, never taken from request input. | — | Reset is a JSON call; the app's own page decides where to go next. |
| 28 | API versioning | **Amended by ADR 34 and ADR 41:** prefixed groups are now `/auth/*`, `/me`, `/accounts/*` and `/password/*`; there are no hosted pages and no `/oauth/*` routes in Phase 1; email links point to app URLs (ADR 39), so the "links embed `/api/v1`" tradeoff below no longer applies. Original: **Global prefix `api/v1`**, set in U2 through `app.setGlobalPrefix('api/v1', { exclude: ['/', 'health', '.well-known/jwks.json'] })` inside a shared `configureApp(app)` function used by both `main.ts` and the e2e test app factory. Prefixed: `/me`, `/accounts/*`, `/password/*`, `/oauth/*` (including the hosted pages `GET /oauth/authorize`, `GET /password/forgot`, `GET /password/reset` and their form posts). Root, unprefixed: `GET /`, `GET /health`, `GET /.well-known/jwks.json` (RFC 8615 requires `.well-known` at the root). Email links: `${AUTH_PUBLIC_BASE_URL}/api/v1/accounts/confirm?token=...`, `/api/v1/password/reset?token=...&client_id=...`, `/api/v1/password/forgot?client_id=...`. | No versioning; NestJS URI versioning (`VersioningType.URI`, `@Controller({ version: '1' })`) per controller | User decision (round 6). A single prefix is one line of config, applies uniformly to every business route and view, and leaves a clear place for a future `/api/v2`. **No versioning, rejected**: the first breaking change would force a path migration for every pilot client with no escape hatch. **URI versioning per controller, rejected**: it adds a version decorator to every controller, makes it easy to forget one, and offers per-route versions that Phase 1 does not need. Sharing `configureApp` between `main.ts` and the e2e factory keeps tests on production routes. **Tradeoff**: if a v2 ever ships, the v1 hosted pages and email links must stay alive for as long as outstanding tokens are valid (confirmation 24h, reset 1h, refresh 30d for login redirects), because links already sent to users embed `/api/v1`. Root routes are version-agnostic by design, so health checks and JWKS discovery never change. |
| 29 | CORS origin allowlist | **Partly superseded by ADR 38.** The any-active-app rule below is kept for preflights and response headers; ADR 38 adds a per-app origin binding on the actual request and extends the route list. Original: CORS allows a request's `Origin` when it exactly matches an entry in `allowed_origins` of **any active app**. `AppRepository.isOriginAllowed(origin)` runs one query (`status = 'active' AND $1 = ANY(allowed_origins)`); `IsOriginAllowedUseCase` caches answers in memory for 30 s (bounded, injected `Clock`). No `client_id` is read from query or body. Origins are validated and normalized at registration (`AllowedOrigin`); client ids are `app_` + 32 hex chars so they never parse as CLI options. | Per-app CORS keyed by `client_id` in query/body | CORS only tells the browser who may read a response; it is not authorization, so per-app isolation adds nothing. The per-app design forced SPAs to append `?client_id=` to every call (preflights have no body, `/me` has only a bearer) and cost one DB lookup per cross-origin request, which also let random `client_id`s hit the DB. Tradeoff: a deactivated app's origin stays allowed for up to the cache TTL. |
| 30 | Outbox worker and templates | The worker claims one email at a time under a **lease**: one short statement (`UPDATE email_outbox SET locked_until = now + 120 s WHERE id = (SELECT ... WHERE status = 'pending' AND next_attempt_at <= now AND (locked_until IS NULL OR locked_until < now) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`), so parallel workers never take the same email and nothing stays locked while it works. Rendering and sending run **outside any transaction** under an overall 60 s deadline (`Promise.race`, timer cleared); the deadline is shorter than the lease, so a live worker finishes first. The outcome (sent, retry or failed) is stored in its own short statement that clears `locked_until` and is **fenced** on `AND locked_until = <the claimed value>`: a worker that lost its lease cannot overwrite the new owner's result. Lease timestamps come from the app clock so they round-trip through a JS `Date` for that equality; instances need clocks within a few seconds. **Delivery is at-least-once**: a crash, or a send that outlives its lease (the deadline abandons the send, it cannot cancel it), can deliver the email again; a lost-lease outcome is discarded and logged. Provider or render failures retry with backoff (30 s doubling, capped at 1 h, 8 attempts); an unknown template, an invalid payload or a missing app fail at once. `sent` and `failed` rows get an empty payload, so a raw token never outlives delivery. Stored and logged error text is bounded (500 chars) and has the recipient and payload values masked case-insensitively. The payload holds only raw inputs (the token); links are built at send time from the app's email URLs (ADR 39). Templates are files `templates/<default or client_id>/<name>.{subject,text}.hbs`, rendered on an isolated Handlebars instance in strict mode; both parts are plain text (not HTML-escaped, subject line breaks collapsed); there is no html part until a requirement asks for one; a `client_id` that is not a plain name is ignored. `SmtpEmailSender` refuses a recipient that is not one plain address (Nodemailer would send to every address in a list) and requires STARTTLS when credentials are set without implicit TLS; the same address rule validates an app's `email_from` at registration and update. **Shutdown**: the poller stops scheduling, the worker stops after the current email, and `onModuleDestroy` awaits the in-flight drain (bounded by the send deadline) before Nest closes the database; Compose gives the api a 70 s stop grace. **Capacity**: the pg pool is explicit (`extra.max` = 10, `DB_POOL_MAX`) and the poller runs one drain at a time, one email at a time, so it holds at most one connection and only for the short claim and completion statements; raising poller concurrency means more parallel drains, with the pool kept above drains plus expected parallel requests. The poller is started by `main.ts` only, so tests and the CLI never poll. | Holding a row lock in a transaction for the whole send (the first implementation); one transaction per batch; a `to` list | A transaction held across SMTP I/O left an idle-in-transaction connection with no overall bound (Nodemailer timeouts are per inactivity), serialized throughput behind provider latency, tied poller concurrency to the HTTP pool, and breaks under `idle_in_transaction_session_timeout` and PgBouncer transaction pooling. The lease costs one nullable column (folded into the unmerged migration) and one extra failure mode (an expired lease can allow a duplicate), which at-least-once delivery already accepts after a crash. |
| 31 | Account signup, confirmation and resend | Accounts are inserted with one `INSERT .. ON CONFLICT DO NOTHING` on `UNIQUE(app_id, email)` (`citext`, emails also normalized to lowercase), so a duplicate is detected atomically and two concurrent signups cannot both win. Signup validates input first (client, email, password: 8 characters, 72 UTF-8 bytes, no NUL), then **hashes the submitted password on every path** before inserting; a duplicate therefore costs the same bcrypt work as a new account, with no dummy hash needed. Inside one `UnitOfWork` it then writes either the account, a confirmation token (SHA-256, 24 h, superseding earlier ones) and a `confirmation` outbox row, or just an `account-exists` outbox row (no token). The HTTP answer is `202` with one fixed body for both. Confirmation consumes the token in a single `UPDATE .. WHERE consumed_at IS NULL AND expires_at > now RETURNING` (single use, race-safe), marks the email verified and queues `welcome` in the same transaction (the mark is a targeted `UPDATE users SET email_verified_at .. WHERE id = $1 AND email_verified_at IS NULL`, never a whole-row save, so a password change committed meanwhile is not overwritten); every failure (malformed, unknown, used, expired) answers `400 invalid_or_expired_link`. Resend answers `202` with one body for unknown, unconfirmed and confirmed accounts. Unknown or inactive `client_id` answers `400 invalid_client` (it is a public identifier; unknown and inactive apps are indistinguishable, as in `ResolveClientUseCase`). bcrypt runs through its async API (libuv threadpool). **CORS: superseded by ADR 38** (was: no CORS on `/accounts/*`). SPAs now call signup, confirm and resend directly, with the origin bound to `client_id` and the limits of ADR 36. **Confirm: amended by ADR 40** (POST with the token in the body). | Dummy-hash compare on the duplicate path; read-then-insert duplicate check; sending email inline; deferring the whole resend to the worker | A dummy hash is a second code path to keep equal to the real one; hashing the real password on both paths makes the equality structural. A read-then-insert check races. Residuals, all **accepted for Phase 1** and now bounded by the Phase 1 limits of ADR 36 (`email_ip`, `email_account`): (1) resend does a few more writes for an unconfirmed account than for an unknown one (milliseconds, with no hash to mask it); this timing gap is explicitly ACCEPTED, with probing throttled by ADR 36; (2) the new-account signup path does one CSPRNG call, one UPDATE and two INSERTs more than the duplicate path, roughly 3-10 ms against about 250 ms for the bcrypt hash both paths share; (3) a duplicate signup floods the owner's inbox. |
| 32 | Signing key delivery (U6) | The key set is one JSON secret: `{ "active": <private JWK>, "next": <private JWK>?, "retired": [<JWK>...]? }`, each with a `kid` (`[A-Za-z0-9_-]{1,64}`), RSA >= 2048 bits. It comes from `AUTH_SIGNING_KEYS` (inline) or `AUTH_SIGNING_KEYS_FILE` (mounted file); exactly one must be set. The xor check and the file read live in the token-lifecycle key store factory (`signingKeysFromEnv`), not in `loadConfig`, so `AppConfig` never holds the secret and the operator CLI boots without any signing key. `JwkSetKeyStore.fromJson` runs at boot and refuses to start on invalid JSON, a missing or mismatched private key (sign/verify self-test on `active` and `next`), a duplicate `kid` or a short key; messages carry slot and rule names only, never key material. JWKS publishes `active`, `next` and `retired` as allow-listed public fields (`kty n e kid alg use`), so private parameters cannot leak by construction. Dev only: `npm run keys:generate` writes a gitignored `.keys/signing-keys.json`; compose runs a one-shot `keygen` service that creates one in a named volume (`down -v` discards it). Production keys come from a secret manager mounted at the `AUTH_SIGNING_KEYS_FILE` path; the generator is never run there. The issuer URL is `AUTH_PUBLIC_BASE_URL` (no new variable). Tokens are signed and verified with `jose` behind the `AccessTokenIssuer` and `AccessTokenVerifier` ports (domain has no `jose` import). The verifier builds its key lookup from the published JWKS only, pins `RS256` itself (not just through the JWKS `alg` hint), requires a `kid`, caps the token at 4096 characters, allows 5 s of clock skew and returns one generic `invalid_token` error. Tokens are typed `typ: at+jwt` (RFC 9068) and the verifier requires it. The expected **audience is a required parameter** of `AccessTokenVerifier.verify` (one `client_id`, or a non-empty list; a missing or empty value throws a `TypeError` rather than skipping the check), so a token for app A never verifies for app B. **U8 `/me` must pass the expected audience.** `/me` is called with a bearer only, so U8 obtains it from the token itself: read `aud` from the still-unverified payload (`decodeJwt`, used only to pick the expectation), accept it only if it is the `client_id` of an active app (`ResolveClientUseCase`, same unknown/inactive handling), then call `verify(token, { audience: thatClientId })`; the signature, `iss`, `typ` and `exp` checks and the `aud` equality all still run, so the unverified value cannot widen what is accepted. A token whose `aud` is not an active app is refused. U8 is not implemented here. **Revision 2:** this flow becomes `AuthenticateBearerUseCase` in `token-lifecycle`, shared by `/me` and `/password/change`, followed by the origin binding of ADR 38. | Keys in the DB (ADR 8); a committed dev key; generating a key in memory at every boot | A committed key would eventually be trusted somewhere, and per-boot keys break multi-instance and restarts. **Rotation** is a config change: add `next`; once ALL instances serve it, wait at least 15 minutes (1 hour recommended), because jose's remote JWKS cache defaults to 10 minutes and ignores `Cache-Control` (the endpoint's 5 minute max-age is not what consumers obey); then move `next` to `active` and the old `active` to `retired` with `retiredAt` (ISO timestamp). Retired keys are published until `retiredAt` + retention (1 h token lifetime + 5 s clock tolerance + 10 min jose cache = 4205 s, `RETIRED_KEY_RETENTION_SECONDS`); at boot expired ones are dropped from JWKS and the verifier with a warning naming only the `kid`. A retired key without `retiredAt` stays published for backward compatibility and logs a no-expiry warning (ADR 9). Tradeoff: rotation needs a redeploy or restart; there is no hot reload in Phase 1. |

## Revision 2 ADRs (API-only)

Sources: `decisions-round8` (API-only), `round9` (limits in Phase 1), `round10` (body transport, required email URLs, two-counter lockout). Numbering starts at 34: number 33 was used only on the discarded U7 branches.

**Superseded index**

| ADR | Status | Replaced by |
|-----|--------|-------------|
| 5 Hosted UI | Superseded | 34, 41 |
| 6 Authorize-request state (HMAC, CSRF) | Superseded | 34 |
| 14 Refresh rotation | Superseded | 35 |
| 24 Email link base | Superseded | 39 |
| 26 Hosted forgot page | Superseded | 34, 39 |
| 27 Post-reset redirect | Superseded | 39 |
| 29 CORS allowlist | Partly superseded (preflight rule kept) | 38 |
| 31 CORS paragraph | Superseded | 38 |
| 33 (U7 branches only: hosted login cookie, no signup page) | Superseded, never merged | 34 |
| Auth Code + PKCE, `authorization-flow`, `authorization_codes` table | Deferred to Phase 4 | 34 |

### ADR 34: Direct first-party credential flow

**Choice:** the app frontend posts `{client_id, email, password}` to `POST /api/v1/auth/login` and receives the token pair as JSON. Session routes live under `/auth/*` (login, refresh, logout).

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Direct login (ROPC-like), `/auth/login` | Simple, works with no Auth UI. App frontends handle the password, so an XSS in an app can capture it; no SSO | **Chosen** (round 8) |
| Auth Code + PKCE with hosted login | Password stays on the Auth origin, SSO-ready; requires the hosted UI that round 8 rules out | Deferred to Phase 4 |
| Proxy through app backends | Backends see passwords, every app re-implements forwarding, and the client IP seen by limits becomes the backend's | Rejected |

**Naming: `/auth/*`, not `/oauth/token` with `grant_type=password`.** OAuth 2.1 removes the password grant and RFC 9700 says it MUST NOT be used. Labelling this flow OAuth would make generic OAuth libraries and reviewers assume semantics we do not provide (form bodies, client authentication, scopes). It would also occupy `/oauth/*`, which Phase 4 needs for the real code flow. The response still reuses RFC 6749 field names (`access_token`, `token_type: "Bearer"`, `expires_in`, `refresh_token`) so client code feels familiar.

**Login ordering** (U7's verified shape, re-implemented in `session-auth`):

1. Parse the body; resolve the client with origin binding (ADR 38). An unknown, inactive or origin-unbound client is **not** a `400`: the session-auth spec makes it the generic login failure. It skips the user lookup but still goes through steps 3 and 5. The limiter key for such a request uses the sentinel client `unknown` plus the IP, so random `client_id` values neither bypass `login_ip` nor grow the table without bound.
2. Normalize the email. A malformed email skips the lookup but still runs step 5.
3. Abuse checks (ADR 36): `checkLoginIp(client, ip)`, then `beginLoginAttempt(client, email, ip)`, which counts both lockout counters atomically before bcrypt. Limited or blocked: generic failure, **no bcrypt**. This is the one deliberate exception to "one bcrypt per attempt": skipping the hash is the point of limiting (CPU protection), and unknown emails are counted and blocked the same way, so the fast path reveals nothing about existence. The session-auth spec states this exception.
4. `findByAppAndEmail`.
5. Exactly ONE `hasher.verify`, against the user's hash or the boot-time dummy cost-12 hash. A password bcrypt cannot hash as given (NUL, over 72 bytes) is compared as `''`. No early return before this step.
6. Decide only now. `user === null || !matches || !confirmed` gives `401 invalid_credentials`, one body for every cause, including limited and blocked. Counting already happened in step 3, so a mismatch records nothing more.
7. Success calls `recordLoginSuccess`, which resets `login_account_ip` only (the pair refund, ADR 36), then creates the session, the refresh token and the access token in one `UnitOfWork` (ADR 35).

### ADR 35: Refresh tokens and sessions

| Topic | Decision |
|-------|----------|
| Format | 256-bit CSPRNG, base64url (existing `TokenGenerator`), stored as SHA-256 `bytea` (ADR 13) |
| Session = family | `auth_sessions` row; its `id` is the family id. Bound to `app_id` and `user_id`. Absolute `expires_at` = login + 30 d |
| Token | One `refresh_tokens` row per issued token: `session_id`, `consumed_at`, `expires_at` = min(now + idle TTL 7 d, session expiry) |
| Rotation | Every refresh consumes the token and issues a successor in the same session, in one `UnitOfWork` |
| Reuse | Presenting a consumed token revokes the whole session (`revoked_reason = 'reuse_detected'`), except inside the grace window below |
| Grace window | Round 11. A rotated token presented again within `REFRESH_REUSE_GRACE_SECONDS` (default 10, `0` disables) of its rotation, from the same `ClientIp` as the rotation, once per rotated token, while its successor is unused: the successor is revoked and a fresh pair is issued in the same session. Details and tradeoffs below |
| Binding | Consume requires the session's `app_id` = the app of `client_id`. A mismatch is plain invalid, with no revoke. An `Origin` not bound to that app gives the same `401 invalid_grant` before any consume (ADR 38) |
| Transport | JSON body in and out. Never a cookie, never `Access-Control-Allow-Credentials` (round 10) |
| Logout | `POST /auth/logout {client_id, refresh_token}` revokes that token's session (consumed or not). Always `204`: idempotent, no oracle |
| Password reset or change | Revokes every active session of the account in the same transaction as the password write |
| Retention | Consumed rows live until session expiry, so late reuse is still detected. A retention job (final unit, started by `main.ts` only) deletes sessions (and their refresh tokens first) once `expires_at < now - 1 day`, `one_time_tokens` once `expires_at < now - 1 day` (consumed or not), and `email_outbox` rows with status `sent` or `failed` older than 7 days. It runs hourly in batches of 1,000. `abuse_counters` rows are swept by their own `AbuseCounterSweeper` (ADR 36). |

Atomic consume, one statement, no `SELECT … FOR UPDATE`:

```sql
UPDATE refresh_tokens t
SET consumed_at = $now, replaced_by_hash = $successorHash, consumed_ip_hash = $ipHash
FROM auth_sessions s
WHERE t.token_hash = $hash AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > $now
  AND s.id = t.session_id AND s.app_id = $appId
  AND s.revoked_at IS NULL AND s.expires_at > $now
RETURNING t.session_id, s.user_id, s.expires_at;
```

The successor token is generated before the statement so its hash can be stored with the consume; the successor row is inserted in the same `UnitOfWork`. When zero rows match, one `SELECT` by hash decides: a consumed or revoked token of the same app goes to the grace check below (a revoked one is never eligible), and anything else is plain invalid. Every failure returns one `401 invalid_grant` (the code the session-auth spec names).

Two tables instead of a `family_id` column: revocation is a one-row update, the absolute expiry is stored once, and Phase 3 session management can list sessions without scanning tokens. Cost: one join per refresh.

**Reuse grace window (round 11, supersedes the earlier "no grace window" choice).** The goal is to avoid logouts when a refresh response is lost on a flaky network (the client retries the token it still holds). It follows the "reuse interval" of Auth0 and Okta.

Columns added to `refresh_tokens` (folded into the unmerged `CreateAuthSessions` migration, U14a):

| Column | Meaning |
|--------|---------|
| `replaced_by_hash bytea NULL` | SHA-256 of the successor issued when this token was consumed. A hash, never the raw token (ADR 13) |
| `consumed_ip_hash bytea NULL` | SHA-256 of the normalized `ClientIp` of the request that consumed it (pseudonymous, as in ADR 36) |
| `grace_used_at timestamptz NULL` | Set once, when this rotated token has used its grace |
| `revoked_at timestamptz NULL` | Set on a successor revoked by a grace reuse |

Flow, when the atomic consume matches zero rows and the follow-up `SELECT` finds a token of the same app that is consumed:

1. Eligible when `now - consumed_at <= grace`, `consumed_ip_hash` equals the hash of the request's `ClientIp`, `grace_used_at IS NULL` and the session is active. Anything else: revoke the session (`reuse_detected`), as before.
2. In one `UnitOfWork`: claim the grace with `UPDATE refresh_tokens SET grace_used_at = $now WHERE token_hash = $hash AND grace_used_at IS NULL RETURNING replaced_by_hash`. Zero rows (a concurrent claim won) means second reuse: revoke the session.
3. Revoke the successor with `UPDATE refresh_tokens SET revoked_at = $now WHERE token_hash = $replacedBy AND consumed_at IS NULL AND revoked_at IS NULL`. Zero rows means the successor was already used or revoked (the real client moved on): roll back and revoke the session.
4. Insert a fresh successor R3 (new CSPRNG token, stored as a hash, same session). Sign a new access token. Respond 200. The session is untouched, and its absolute expiry is unchanged.
5. A token with `revoked_at` set that is presented later is a reuse like any other: it revokes the session. Presenting a token with `revoked_at` never takes the grace path.

Properties: the raw successor is never stored or re-issued; grace is at most once per rotated token; a thief on another IP or outside the window kills the session as before. Residual risk, accepted: a thief on the SAME IP (/64) inside 10 s of a rotation can obtain a live token instead of ending the session. Misconfigured `TRUST_PROXY` makes every client share one IP and widens this window to "anyone inside 10 s", so operators must set `TRUST_PROXY` correctly (ADR 37; for limits this fails safe, for grace it does not). Measured from `consumed_at`; `now` comes from the injected `Clock`.

**Concurrency.** Under READ COMMITTED, a second concurrent `UPDATE` on the same token waits for the row lock, re-checks `consumed_at IS NULL`, matches nothing, and takes the path above: from the same IP it is a first grace reuse (the winner's successor is revoked and the second caller gets a fresh pair); a third concurrent caller is a second reuse and revokes the session. The winner of the rotation then holds a revoked successor, and using it revokes the session. Two tabs refreshing at once therefore still lose the session on their next refresh, only later: the grace is for lost responses, not for racing tabs, and clients must keep serializing refreshes.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Grace window, ~10 s, same IP, revoke the successor and mint a fresh token in the same session | Fewer logouts on flaky networks, no raw token at rest, one extra state per rotated token. A same-IP thief inside the window keeps access | **Chosen** (round 11) |
| No grace window; clients serialize refresh | A lost response logs out; the reuse signal stays exact | Superseded |
| Grace window that mints a sibling token (successor kept alive) | Branches the family and leaves two live tokens | Rejected |
| Grace window that returns the same successor | Requires storing the successor recoverably (a raw token at rest) | Rejected |

**Client guidance (SDK and README):** run at most one refresh at a time per page (one shared in-flight promise). When tabs share storage, wrap the refresh in `navigator.locks.request('hypot-refresh:<client_id>', …)` and re-read the stored refresh token after acquiring the lock, because another tab may have rotated it. Refresh shortly before `expires_in` runs out, not on every 401. If a refresh response is lost, the app MAY retry once with the same token, within the grace window and from the same network; a second retry, or a retry after the window, ends the session.

### ADR 36: Abuse protection with Postgres counters

**Policies.** Defaults below; every limit, window and block length is configurable (`ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS`, `_BLOCK_SECONDS`).

| Scope | Key | Counts | Default | When exceeded |
|-------|-----|--------|---------|---------------|
| `login_ip` | client + IP | every login request | 100 / 15 min | Generic `401` until the window ends |
| `login_account_ip` | client + email + IP | login attempts, counted before bcrypt | 5 / 15 min | The 6th attempt and later are blocked; that IP is blocked 15 min for that account |
| `login_account` | client + email | login attempts from any IP, counted before bcrypt | 50 / 1 h | The 51st attempt and later are blocked; the account is blocked 15 min |
| `email_ip` | client + IP | signup, resend, forgot requests | 20 / 1 h | `429` with `Retry-After` (see below) |
| `reset_ip` | IP | reset requests | 20 / 1 h | `429` with `Retry-After` |
| `confirm_ip` | IP | confirm requests (round 11) | 20 / 1 h | `429` with `Retry-After` |
| `refresh_ip` | client + IP | refresh requests (round 11) | 60 / 15 min | `429` with `Retry-After` |
| `email_account` | client + email | signup, resend, forgot requests | 3 / 1 h | Normal generic response; the email is silently not queued |

`reset_ip` and `confirm_ip` are keyed by IP alone: those bodies carry no `client_id`, and the check must run before any token lookup, so the app is not known yet. `refresh_ip` is keyed by client and IP and runs before the token lookup. `GET /me` has no limiter: verifying a bearer is a local signature check with no database access (the active-app lookup is cached, ADR 29), so there is nothing to protect that needs a counter. Logout has no limiter: it is idempotent and reveals nothing. The `refresh_ip` default allows a NAT of many users (each refreshes about once an hour, plus retries); all numbers are configurable.

Counters run for unknown emails too, so they reveal nothing about existence. `POST /password/change` checks the two lockout counters before bcrypt and records them on a wrong current password. While blocked, change returns the same `400 invalid_current_password` as a wrong password, even for the correct one (ADR 43). Every email that `forgot` sends, including a confirmation email for an unconfirmed account, counts toward `email_account`. Keys are SHA-256 of the composite; this is pseudonymous, not anonymous (emails are guessable), and rows are short-lived. The `email_account` default is 3 / 1 h, as in the abuse-protection spec (an earlier draft said 5).

**Response rules (the abuse-protection spec wins).**
- **Login never returns `429`.** Limited, blocked and locked logins return the same generic `401` as a failed login. This is structural (round 12): login's per-IP limit is `AbuseGuard.checkLoginIp(client, ip): Promise<boolean>` with no Retry-After, and the generic `checkIp`/`checkClientIp` types refuse the `login_ip` scope (a `@ts-expect-error` spec fails `npm run typecheck` if that is loosened).
- **Limits keyed only by IP on the other endpoints** (`email_ip`, `reset_ip`, `confirm_ip`, `refresh_ip`) return `429` with `Retry-After` (an integer number of seconds until the window ends, at least 1) and the generic body `{ "error": "rate_limited", "message": "Too many requests. Try again later." }`. A `429` on refresh is never `invalid_grant`, so a client does not log the user out. The decision depends only on the caller's IP and the endpoint group, never on account state, so it cannot enumerate accounts.
- **Per-account email caps** (`email_account`) never return `429`. They return the normal generic response and send nothing. For signup the account is still created; only the email is suppressed.
- Tradeoff: a legitimate user behind a shared NAT can see `429` on signup or forgot, which is why the IP defaults are generous. The `429` body code is `rate_limited` (the spec only says "generic body").

**Data model.**

| Option | Cost per event | Accuracy | Decision |
|--------|----------------|----------|----------|
| Fixed window anchored at the first hit, one row per key | One upsert; table size bounded by active keys | Up to 2x burst across a window edge. Lockout uses an explicit `blocked_until`, so block length is exact | **Chosen** |
| Sliding log (one row per event, `COUNT`) | Insert plus range count; the table grows with traffic | Exact | Rejected: write and vacuum amplification |
| Sliding window counter (two weighted buckets) | Upsert plus a two-row read | Near exact | Rejected: extra read and math, no Phase 1 benefit |
| `@nestjs/throttler` in memory, or Redis | Fast | In-memory counters are per instance; Redis is out of scope | Rejected |

Table `abuse_counters`, created `UNLOGGED`: `scope text`, `key bytea`, `window_start`, `count int`, `blocked_until NULL`, `expires_at`; primary key `(scope, key)`; index on `expires_at`. One atomic statement per hit:

```sql
INSERT INTO abuse_counters AS c (scope, key, window_start, count, blocked_until, expires_at)
VALUES ($scope, $key, $now, 1, NULL, $now + $window)
ON CONFLICT (scope, key) DO UPDATE SET
  window_start = CASE WHEN c.window_start + $window <= $now THEN $now ELSE c.window_start END,
  count        = CASE WHEN c.window_start + $window <= $now THEN 1 ELSE c.count + 1 END
  -- blocked_until and expires_at are derived in the same SET from the new count
RETURNING count, blocked_until;
```

- **Contention.** A hot key serializes on one row lock, held only for that statement. The store always uses the root `DataSource` manager, never the ALS transactional manager (ADR 16). A rolled-back business transaction therefore cannot undo a count, and no lock is held across bcrypt.
- **`UNLOGGED`.** No WAL for a table written on every request. A crash or failover empties it, so counters restart and an attacker gets at most one fresh window. `ALTER TABLE … SET LOGGED` reverts this if HA needs change.
- **Time.** `$now` comes from the injected `Clock`, not `now()`, as with the outbox lease (ADR 30). This keeps tests deterministic.
- **Cleanup.** An `AbuseCounterSweeper`, started by `main.ts` only (the outbox-poller pattern), deletes expired rows every 5 min in batches of 1,000.
- **Ordering.** Checks run before the user lookup and before bcrypt. Keys need no user row. The login lockout counts the attempt BEFORE bcrypt (see "Login pre-count" below), not after it.
- **Client identity (round 12).** The guard accepts a `ClientRef`, never a raw string. `ClientRef.resolved(id)` is created only for an active, resolved app; `ClientRef.unknown()` is the shared sentinel. A raw `client_id` from a body would mint a counter per random id and bypass `login_ip`, `email_ip` and `refresh_ip` while growing the table; the type makes that a compile error, and every unknown client shares one counter per IP.
- **CORS on `429` and `503` (round 12).** `AbuseExceptionFilter` grants `Access-Control-Allow-Origin` to the request's candidate origin (stashed by the CORS middleware only for an active app's origin) on both statuses. The bodies are static and carry no app or account data, so no controller has to remember to grant them. A request with no `Origin`, or an unknown one, gets no allow header.
- **Outage log (round 12).** A limiter store failure logs `abuse limiter store unavailable (<scope>): <driver message>` and nothing else (no keys, IPs or parameters), at most once per 60 s per process, so an outage cannot flood the log.

**Login pre-count (round 12, replaces check-then-act).** A read-only `isLoginBlocked` before bcrypt plus a failure increment after it lets N parallel logins all pass the check before any failure lands: one IP could fire up to its `login_ip` limit (100) in guesses instead of 5. `AbuseGuard.beginLoginAttempt(client, email, ip): 'allowed' | 'blocked'` therefore counts the attempt first, with one atomic upsert per counter:

1. Hit `login_account_ip`. If it is over its limit, or an older block is still active, answer `blocked` and stop.
2. Otherwise hit `login_account` and apply the same rule.

Exactly `limit` attempts per window are `allowed`; the attempt that reaches the limit starts the block but is the last allowed one. A block older than the hit (it survives a window rollover) blocks even though the count restarted. Step 2 is skipped for a blocked pair so an attacker hammering from a blocked IP cannot lock the account for everyone. `recordLoginSuccess` resets only the pair counter, which refunds that attempt. **Assumption (deviation from the literal "failures" wording):** the global counter counts attempts, and a success does NOT refund it. Successes are rare against the limit of 50, and a refund (a decrement) would reopen the race the pre-count closes. The cost is that legitimate logins use up the account's 50 attempts per hour; that is far above human use. `POST /password/change` uses the same two calls. `recordLoginFailure` and the store's `blockedUntil` read no longer exist.

**Fail mode when a limiter statement errors:**

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Fail closed: `503 temporarily_unavailable` | Login is briefly unavailable. The user query on the same database would almost always fail anyway | **Chosen** |
| Fail open: log and continue | Login stays up when only the limiter fails. An attacker who can induce limiter-only errors (lock waits on a hot key) bypasses the control | Rejected |

The `503` is raised before any account lookup, so it reveals nothing about accounts.

### ADR 37: Client IP and `trust proxy`

**Choice:** `configureApp` sets Express `trust proxy` from config `TRUST_PROXY` (the abuse-protection spec uses the same name). Allowed values are `false` (default), a hop count, or a comma-separated list of CIDRs or Express names (`loopback`, `uniquelocal`). The value `true` is rejected at boot. Controllers pass `req.ip` to use cases. `abuse-protection/domain` normalizes it: IPv4-mapped IPv6 becomes IPv4, and IPv6 is keyed on its /64 prefix, because one subscriber usually owns a /64.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Explicit `trust proxy` from config | Operators must set it behind a load balancer. If they forget, all users share the proxy IP and limits trip early: this fails safe (over-limiting, never bypass) | **Chosen** |
| Read `X-Forwarded-For` directly, or `trust proxy = true` | Any client spoofs its IP when no proxy strips the header | Rejected |
| Key IPv6 per full address | Rotating addresses inside a /64 is free | Rejected |

### ADR 38: CORS bound to the client (amends ADR 29)

**CORS routes:** `auth/login`, `auth/refresh`, `auth/logout`, `accounts/signup`, `accounts/confirm`, `accounts/resend-confirmation`, `password/forgot`, `password/reset`, `password/change`, `me`.

**Two layers:**

1. **Headers (ADR 29, grant timing amended).** `AppCorsMiddleware` answers preflights with `Access-Control-Allow-Origin` when `Origin` belongs to any active app, with the 30 s cache kept, and never sets credentials. **Fail-closed grant:** on an actual request it only sets `Vary: Origin` and stashes the candidate origin; `Access-Control-Allow-Origin` is granted by the endpoint (`@CorsGrant()`) after its binding passes, or for answers with no app data (request-validation 400, 429). Binding rejections and unexpected 500s never get it, and an endpoint that forgets to grant fails visibly (CORS error) instead of leaking. **Preflight answer (round 11):** `204` with `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization` (fixed list, no longer echoed from the request), `Access-Control-Max-Age: 600` and `Vary: Origin`; no `Access-Control-Allow-Credentials`. Every CORS response carries `Vary: Origin`.
2. **Binding (new, application layer).** `ResolveClientUseCase.execute(clientId, { origin })` returns `invalid_client` when an `Origin` header is present and is not in that app's `allowed_origins`.
   - Body endpoints pass the body `client_id`.
   - Token-in-body endpoints (`accounts/confirm`, `password/reset`) carry no `client_id` (the specs take `{token}` alone): a read-only lookup finds the app that owns the token, then the origin is bound to that app before the consume runs. An unknown token, or a known token from the wrong origin, gives the same generic `invalid_or_expired_link`, so the origin check is not a token oracle.
   - On `auth/login` any client failure is the generic login `401` (ADR 34). **Amended in round 11 for the token endpoints:** on `auth/refresh` an origin not bound to the app of `client_id` gives the same `401 invalid_grant` as an invalid token, so a response never reveals whether a token is valid (an unknown or inactive `client_id` is still `400 invalid_client`: it is a public identifier and a setup bug); on `auth/logout` it is still `204`, with NO effect (nothing is revoked) and no allow header. On signup, resend and forgot it stays `400 invalid_client`.
   - Bearer endpoints (`/me`, `/password/change`) use the token's `aud`, resolved as in ADR 32: decode `aud`, require an active app, verify with that audience, then bind the origin to that app.
   - Requests with no `Origin` (native apps, servers) skip the binding; the limits still apply.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Preflight checks any active app; the actual request enforces the binding | The preflight cannot see the body, but enforcement still happens before any side effect | **Chosen** |
| `client_id` in the path (`/apps/{id}/auth/login`) so the preflight can bind | True per-app preflight. It changes every route and the SDK for no extra protection, because the actual request is checked anyway | Rejected |
| `client_id` in a query string on every call | Same objections as in ADR 29 | Rejected |
| CORS headers only, no binding | CORS hides responses but does not stop execution. JSON forces a preflight, which passes for any registered origin, so app A's origin could drive login or signup for app B | Rejected |

### ADR 39: Per-app email link URLs (supersedes ADR 24 and ADR 27)

**Migration `1760000004000-AppEmailLinkUrls`.**
- `up()`: adds `email_confirmation_url text NULL` and `password_reset_url text NULL`, and drops `post_reset_redirect_uri`.
- `down()`: re-adds `post_reset_redirect_uri text NULL` and drops the two columns.
- Values are lost in both directions, which is acceptable because the database is dev-only.

**Required in the use cases.** Register requires both URLs. Update may change them but never clear them (no `--clear-*` flag). The domain `App` types them as `string | null` only so legacy rows can be read. Signup, resend and forgot on an app with a null URL fail with `400 unconfigured_client` before any account work. The error describes the app, not the account.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Nullable column, required by the use cases | Runs on any database; legacy dev apps need one `app update`; the database does not enforce it | **Chosen** |
| `NOT NULL` with a placeholder backfill | Would put fake URLs into real emails | Rejected |
| `NOT NULL` that fails when rows exist | Forces manual deletes before migrating and breaks dev databases mid-chain | Rejected now. Follow-up: a Phase 2 `SET NOT NULL` migration once every row has values |

**Email URL origin rule (round 11).** The origin of `email_confirmation_url` and `password_reset_url` must equal one of the app's `allowed_origins` (compared after the same normalization as `AllowedOrigin`). Otherwise the app's confirm and reset pages could receive the email link but could not call Auth from the browser (ADR 38 would reject their origin). The check lives in the register and update use cases, so it also fires when an update changes only the origins and would orphan a URL; invalid input persists nothing. It is a cross-field rule between `AppUrl` and `AllowedOrigin`, so it sits in the application layer (or one domain function over both), not inside either value object. Legacy rows with null URLs are unaffected until their one `app update`.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Enforce at create and update | A mistake surfaces at the operator's terminal, not in a user's browser | **Chosen** |
| Warn only | A silently broken confirm screen in production | Rejected |
| Derive the URL origin into `allowed_origins` automatically | Hidden widening of the CORS allowlist | Rejected |

**Value object.** `PostResetRedirectUri` is renamed to `AppUrl` and reused for both URLs, with the same rules: absolute, https (or http for localhost outside production), no userinfo, no fragment. The fragment is forbidden because Auth appends one. Deleting it and writing two new value objects would duplicate the rules. `redirect_uris`, `client_type` and `client_secret_hash` stay dormant for Phase 4; no Phase 1 endpoint reads them.

**Links (replaces ADR 24).**
- The worker builds links at send time from the app's current record: `${email_confirmation_url}#token=<token>` and `${password_reset_url}#token=<token>`, with the token percent-encoded. The outbox payload still holds only the token.
- The `account-exists` notice links to the app's `password_reset_url` **without a token and without a fragment** (the original user decision: "suggest login or reset"). It carries no token, so no third URL is needed.
- `AUTH_PUBLIC_BASE_URL` remains only the JWT issuer.

**Why the fragment.** Browsers never send it to servers, proxies, access logs or `Referer`, and a mail scanner that fetches the URL consumes nothing. App guidance: read `location.hash`, strip it with `history.replaceState`, and do both before loading any third-party script.

### ADR 40: Confirmation by POST

**Choice:** `POST /api/v1/accounts/confirm {token}` replaces the GET (the user-accounts spec takes the token alone; the token already identifies the account and app, and the origin is bound to that app, ADR 38). Every failure returns `400 invalid_or_expired_link`.

**Rationale:** consuming on GET let link scanners burn tokens (U5 S3). **Rejected:** keeping the GET behind an interstitial page, which needs a page Auth no longer serves.

### ADR 41: No page rendering

**Choice:** Auth has no view engine for pages, no CSP or CSRF page middleware and no hosted-page code. Handlebars stays only inside `transactional-email` for templates (isolated instance, ADR 30).

### ADR 42: Module boundaries

| Module | Owns | May depend on |
|--------|------|---------------|
| `abuse-protection` (new) | Policies, counter store port and Postgres adapter, client-IP normalization, sweeper | `shared-kernel` only (leaf) |
| `token-lifecycle` (narrowed) | Keys, JWKS, access-token issuer and verifier, `AuthenticateBearerUseCase` (ADR 32 audience flow) | `app-registry` |
| `user-accounts` | Signup, confirm, resend, `GET /me` | `app-registry`, `abuse-protection`, `token-lifecycle` |
| `session-auth` (new, replaces `authorization-flow`) | Login, refresh, logout, sessions, refresh tokens, `RevokeAccountSessionsUseCase` | `user-accounts` ports, `app-registry`, `token-lifecycle`, `abuse-protection` |
| `password-management` | Forgot, reset, change | `user-accounts`, `app-registry`, `session-auth`, `abuse-protection`, `token-lifecycle` |

**Rule:** modules use each other only through exported use cases or domain ports, never through another module's infrastructure. The graph is acyclic.

| Option | Tradeoff | Decision |
|--------|----------|----------|
| Limits inside use cases | One place, `Clock`-testable. The lockout needs the normalized email and the outcome, which only the use case knows | **Chosen** |
| Nest guards or interceptors | They run before the outcome is known, so per-IP limits and lockout would be split across two places | Rejected |
| Refresh inside `token-lifecycle` | Mixes stable crypto with credential and session rules that change for other reasons (proposal) | Rejected |

### ADR 43: API contract rules (round 11)

Closes the gaps found while writing `docs/api-contract.md`. Where an earlier ADR or spec text disagrees, this table wins.

| Topic | Decision |
|-------|----------|
| Error body | `{ "error": "<code>", "message": "<human text>" }` on every endpoint, matching the built signup, confirm and resend. Clients branch on `error` |
| Generic bodies | Signup, resend (as built) and forgot return fixed texts, identical on every path: forgot `"If an account exists for this address, an email is on its way."` |
| Confirm success | `200 { "message": "Your email address has been confirmed." }` |
| Login `400` | `invalid_request` (also refresh, logout, forgot and every body endpoint for a missing or non-string field) |
| Bearer failures | `401 { "error": "invalid_token", "message": ... }` with `WWW-Authenticate: Bearer`, one body and header set for every cause (`/me`, `change`). Login `401` keeps `invalid_credentials` and sends no `WWW-Authenticate` |
| `GET /me` | `{ id, email, email_verified, created_at }`. `id` equals `sub`; `created_at` ISO 8601 UTC. Auth stores identity and credentials only: no name or profile. Apps keep profiles and link them by `id` |
| Change password, wrong current | `400 invalid_current_password`, never `401` (a `401` is indistinguishable from an expired token and makes clients refresh in a loop). It counts toward both lockout counters. While the pair is blocked or the account locked, the same `400` even for the correct password, without bcrypt. Check order: bearer, body shape, new-password rules (no counter touched), lockout state, compare |
| Forgot for an unconfirmed account | Generic `202`; sends a CONFIRMATION email (a new token superseding earlier ones, the resend path) instead of a reset, because a reset cannot be used to log in. Counts toward `email_account`. Residual timing: the write set differs for unknown versus existing accounts by a few milliseconds, accepted for the same reasons as ADR 31 and bounded by `email_ip` and `email_account` |
| `Retry-After` | Integer seconds, at least 1 |
| Issuer and JWKS | `iss` is exactly `AUTH_PUBLIC_BASE_URL`; the JWKS URL is `${iss}/.well-known/jwks.json`. Production value: an `https` URL with no trailing slash, no query and no fragment. Auth does not rewrite the value, so the operator must configure it in that form (a config check is task 19.13) |
| Preflight | See ADR 38 |
| Limits on refresh and confirm | See ADR 36 |

**Rejected:** a `401` with a distinct code for the wrong current password (still the same status as an expired token, so a client that refreshes on `401` could loop), and a `204` or generic `200` on confirm (clients need a stable success shape; the fixed message costs nothing).

## Module Structure

Paths below are shown with the `/api/v1` prefix except the three root routes (ADR 28).

```
src/
  app-registry/        domain/ application/ infrastructure/{persistence,cli} http/ (AppUrl, CORS middleware, origin binding)
  abuse-protection/    domain/ (policies, CounterKey, ClientIp) application/ (AbuseGuard) infrastructure/ (PostgresAbuseCounterStore, AbuseCounterSweeper)
  token-lifecycle/     (GET /.well-known/jwks.json at the root; issuer, verifier, AuthenticateBearerUseCase)
  user-accounts/       (POST /api/v1/accounts/signup, POST /api/v1/accounts/confirm, POST /api/v1/accounts/resend-confirmation, GET /api/v1/me)
  session-auth/        (POST /api/v1/auth/login, POST /api/v1/auth/refresh, POST /api/v1/auth/logout)
  password-management/ (POST /api/v1/password/forgot, POST /api/v1/password/reset, POST /api/v1/password/change)
  transactional-email/ (outbox, worker, renderer, SmtpEmailSender, templates/{default,<client_id>}/)
  shared-kernel/       (Clock, TokenGenerator, Result/DomainError, UnitOfWork port)
  platform/            welcome.controller.ts (GET /), config, health, openapi,
                       configure-app.ts (global prefix and trust proxy, shared by main.ts and the e2e factory),
                       persistence/{typeorm.options.ts, data-source.ts, typeorm-unit-of-work.ts, migrations/}
  main.ts  cli.ts
test/e2e/  test/support/ (testcontainers + migrated DataSource, fakes, fixed RSA key, createTestApp factory)
```

**Bootstrap note (ADR 28):** the prefix lives in one shared function, `configureApp(app)` in `platform/configure-app.ts`. Both `main.ts` and the e2e test app factory (`test/support/create-test-app.ts`) call it right after `NestFactory.create` / `Test.createTestingModule(...).createNestApplication()`. E2E tests therefore hit the production route layout, and no test can pass on a path that production does not serve.

`typeorm.options.ts` builds one options object from validated config. Both `TypeOrmModule.forRootAsync` and the CLI `data-source.ts` use it, so the app and the migrations never drift. Each module registers its own schemas with `TypeOrmModule.forFeature`.

**Module notes (ADR 39):** `app-registry/domain` owns the `AppUrl` (renamed from `PostResetRedirectUri`), `AllowedOrigin` and `AppRedirectUri` value objects. They are pure, with no Nest or config imports: origins are normalized, URLs kept verbatim, and all of them take the `isProduction` rule as an input. The register and update use cases receive `isProduction` from the CLI composition root, which reads `NODE_ENV` from validated config. `AppRedirectUri` is dormant until Phase 4.

**Ports (in domain):** `AppRepository`, `UserRepository`, `OneTimeTokenRepository`, `SessionRepository` (sessions and refresh tokens), `AbuseCounterStore`, `PasswordHasher`, `AccessTokenIssuer`, `AccessTokenVerifier`, `KeyStore`, `EmailOutbox`, `EmailSender`, `TemplateRenderer`, `Clock`, `TokenGenerator`, `UnitOfWork`.

## Data Model

Each table is defined by an `EntitySchema` and created by a migration with `down()`. Column mappings are `bytea` → `Buffer`, `text[]` → `type: 'text', array: true`, and enums → Postgres enum types. The `users` migration runs `CREATE EXTENSION IF NOT EXISTS citext`.

| Table | Key columns |
|-------|-------------|
| `apps` | `id uuid`, `client_id text UNIQUE`, `name`, `client_type enum(public, confidential)`, `client_secret_hash bytea NULL`, `redirect_uris text[]` (dormant until Phase 4), `allowed_origins text[]`, `email_from`, `email_confirmation_url text NULL`, `password_reset_url text NULL` (both required by the use cases, ADR 39), `status`, timestamps. `post_reset_redirect_uri` is dropped. |
| `users` | `id uuid`, `app_id FK`, `email citext`, `password_hash`, `email_verified_at NULL`, `password_changed_at`, timestamps, **UNIQUE(app_id, email)** |
| `auth_sessions` | `id uuid` (the family id), `app_id FK`, `user_id FK` (indexed), `created_at`, `last_used_at`, `expires_at` (absolute, 30 d, indexed), `revoked_at NULL`, `revoked_reason enum(logout, reuse_detected, password_changed, password_reset, ops_revoke_all) NULL` (ADR 35; `ops_revoke_all` is set by the key-compromise CLI) |
| `refresh_tokens` | `token_hash bytea PK`, `session_id FK` (indexed), `expires_at` (idle, 7 d, capped at session expiry), `consumed_at NULL`, `created_at`, and for the reuse grace window `replaced_by_hash bytea NULL`, `consumed_ip_hash bytea NULL`, `grace_used_at NULL`, `revoked_at NULL` (ADR 35) |
| `abuse_counters` | `UNLOGGED`. `scope text`, `key bytea`, `window_start`, `count int`, `blocked_until NULL`, `expires_at` (indexed), **PK(scope, key)** (ADR 36) |
| `one_time_tokens` | `id`, `user_id FK`, `purpose enum(email_verification, password_reset)`, `token_hash bytea UNIQUE`, `expires_at` (24h or 1h), `consumed_at NULL`. Issuing a new token invalidates earlier unconsumed ones for the same purpose. |
| `email_outbox` | `id`, `app_id FK`, `to_address` (`to` is a reserved word), `template`, `payload jsonb`, `status enum(pending, sent, failed)`, `attempts`, `next_attempt_at`, `last_error`, `locked_until` (lease expiry, null when unclaimed), `created_at`. Partial index on `next_attempt_at` where `status = 'pending'`. |

## Data Flow

**Login (ADR 34, 36)**

```
SPA -- POST /api/v1/auth/login {client_id,email,password}, Origin --> Auth
  resolve client + origin binding ............ fail -> generic 401 (still hits login_ip, ONE dummy bcrypt)
  hit login_ip; read account/account+IP blocks  limited|blocked -> 401 (no bcrypt, never 429)
  find user; ONE bcrypt verify (real or dummy hash)
  mismatch -> record 2 failure counters -> 401 invalid_credentials
  unconfirmed -> 401 invalid_credentials
  ok -> reset account+IP counter; UoW{ insert session, insert refresh } ; sign JWT
<-- 200 {access_token, token_type, expires_in, refresh_token}
```

**Refresh rotation (ADR 35)**

```
SPA -- POST /api/v1/auth/refresh {client_id, refresh_token} --> Auth
  hit refresh_ip -> 429 + Retry-After when limited ; origin bound to client_id? no -> 401 invalid_grant
  UoW{ UPDATE..RETURNING consume (stores successor hash + IP hash) ; insert successor ; touch session }
    consumed by this call -> 200 new pair
    0 rows, token consumed (same app), inside grace, same IP, grace unused, successor unused
        -> UoW{ claim grace ; revoke successor ; insert fresh token } -> 200 new pair, same session
    0 rows, token consumed or revoked (same app), any other case -> revoke session -> 401
    0 rows, anything else -> 401 invalid_grant
```

**Email link (ADR 39, 40)**

```
worker: link = app.email_confirmation_url + "#token=" + token  -> SMTP
user opens app page -> app reads location.hash, strips it
app -- POST /api/v1/accounts/confirm {token} --> Auth (origin bound to the token's app, single-use consume)
```

**Persistence path:** use case → port → TypeORM repository (manager from ALS) → `EntitySchema` row → mapper → domain model. Exception: `abuse-protection` always uses the root manager (ADR 36).

Logout revokes the session of the presented refresh token. A password change or reset revokes every session the account has (accounts are per app).

## Interfaces / Contracts

```ts
// Access JWT: header { alg: 'RS256', kid }
interface AccessTokenClaims { iss: string; sub: string; aud: string /* client_id */; iat: number; exp: number; jti: string; }
interface KeyStore { activeSigningKey(): SigningKey; publicJwks(): JsonWebKeySet; }
interface PasswordHasher { hash(p: string): Promise<string>; verify(p: string, h: string): Promise<boolean>; needsRehash(h: string): boolean; }

// infrastructure/persistence only
interface AppRow { id: string; client_id: string; client_secret_hash: Buffer | null; email_confirmation_url: string | null; password_reset_url: string | null; /* ... */ }
const AppSchema = new EntitySchema<AppRow>({ name: 'App', tableName: 'apps', columns: { /* ... */ } });
const AppMapper = { toDomain(row: AppRow): App { /* ... */ }, toPersistence(app: App): AppRow { /* ... */ } };

// session-auth (ADR 34, 35): field names follow RFC 6749 for familiarity only
interface TokenPairResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; }
interface SessionRepository {
  open(session: NewSession, firstTokenHash: Buffer): Promise<void>;
  consume(tokenHash: Buffer, appId: string, now: Date, successorHash: Buffer, ipHash: Buffer | null): Promise<ConsumedToken | null>; // UPDATE..RETURNING
  findTokenState(tokenHash: Buffer): Promise<{ sessionId: string; appId: string; consumed: boolean; consumedAt: Date | null; consumedIpHash: Buffer | null; graceUsed: boolean; revoked: boolean } | null>;
  claimGrace(tokenHash: Buffer, now: Date): Promise<Buffer | null>; // returns replaced_by_hash, null when already claimed
  revokeToken(tokenHash: Buffer, now: Date): Promise<boolean>; // false when the token was already used or revoked
  addToken(sessionId: string, tokenHash: Buffer, expiresAt: Date): Promise<void>;
  revoke(sessionId: string, reason: RevokeReason, now: Date): Promise<void>;
  revokeAllForUser(userId: string, reason: RevokeReason, now: Date): Promise<void>;
}

// abuse-protection (ADR 36)
interface AbuseCounterStore {
  hit(scope: Scope, key: Buffer, policy: Policy, now: Date): Promise<{ count: number; blockedUntil: Date | null; windowEndsAt: Date }>;
  reset(scope: Scope, key: Buffer): Promise<void>;
}
```

**Route table** (revision 2, API-only):

| Method + path | Module | Purpose |
|---------------|--------|---------|
| `GET /` | platform | Welcome message |
| `GET /health` | platform | Liveness plus DB ping |
| `GET /.well-known/jwks.json` | token-lifecycle | Public keys |
| `POST /api/v1/auth/login` | session-auth | `{client_id, email, password}` → token pair; generic `401` (ADR 34) |
| `POST /api/v1/auth/refresh` | session-auth | `{client_id, refresh_token}` → rotated pair (ADR 35) |
| `POST /api/v1/auth/logout` | session-auth | `{client_id, refresh_token}` → `204`, revokes the session |
| `GET /api/v1/me` | user-accounts | Profile for the bearer token (ADR 32 audience flow) |
| `POST /api/v1/accounts/signup` | user-accounts | Registration, generic `202` |
| `POST /api/v1/accounts/confirm` | user-accounts | `{token}`, single use (ADR 40) |
| `POST /api/v1/accounts/resend-confirmation` | user-accounts | Generic `202` |
| `POST /api/v1/password/forgot` | password-management | `{client_id, email}`, generic `202`; reset email for a confirmed account, confirmation email for an unconfirmed one (ADR 43) |
| `POST /api/v1/password/reset` | password-management | `{token, new_password}`; token-bound app, password write and revocation of all sessions in one UoW |
| `POST /api/v1/password/change` | password-management | Bearer plus `{current_password, new_password}`; lockout counters apply; revokes all sessions |

The route table has 13 routes: 10 under `/api/v1` and 3 at the root (ADR 28). Preflight `OPTIONS` is answered by the CORS middleware on the 10 API routes (ADR 38). Exact status codes, error codes and request bodies are owned by the specs; where this design differs, the spec wins. Names the specs leave open: `invalid_credentials` (login, change), `invalid_client` (`400`, non-login body endpoints), `invalid_or_expired_link` (confirm, reset), `unconfigured_client` (`400`, null email URL), `rate_limited` (`429`) and `temporarily_unavailable` (`503`). The refresh failure is `invalid_grant`. Round 11 adds `invalid_request` (`400`, malformed body on every endpoint), `invalid_current_password` (`400`, change), `invalid_token` (`401`, `/me` and change) and `invalid_email` and `invalid_password` as built (ADR 43).

**Config schema (zod)** adds (revision 2): `TRUST_PROXY` (ADR 37, default `false`, `true` rejected), `REFRESH_IDLE_TTL_SECONDS` (default 604800), `REFRESH_ABSOLUTE_TTL_SECONDS` (default 2592000), `REFRESH_REUSE_GRACE_SECONDS` (default 10, `0` disables, ADR 35), and `ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS`, `_BLOCK_SECONDS` for each ADR 36 scope. Earlier units added: `AUTH_PUBLIC_BASE_URL` (required, absolute URL), `SMTP_HOST` (required), `SMTP_PORT` (number, default 587), `SMTP_SECURE` (boolean, default false; true means implicit TLS, usually port 465), `SMTP_USER` and `SMTP_PASS` (optional pair, both or neither, so a local catcher needs no auth), and `MAIL_FROM` (required default sender). `SMTP_PASS` is never logged.

```ts
interface EmailMessage { to: string; from: string; subject: string; text: string; }
interface EmailSender { send(message: EmailMessage): Promise<void>; } // SmtpEmailSender wraps nodemailer.createTransport
```

The outbox worker resolves `from` as `app.email_from ?? MAIL_FROM` and builds links from the app's `email_confirmation_url` or `password_reset_url` with `#token=` (ADR 39).

`GET /` returns `200 { "message": "Welcome to the API" }`. `GET /.well-known/jwks.json` returns `Cache-Control: public, max-age=300`. No Phase 1 endpoint uses client secrets or PKCE. CORS headers follow ADR 29 (any active app) and the origin binding follows ADR 38.

## Testing Strategy

| Layer | What | How |
|-------|------|-----|
| Unit | Entities, rotation and reuse rules, use cases, mapper round-trips, `AppUrl`, IP normalization (IPv4-mapped, IPv6 /64) | Jest with in-memory port fakes and a fixed `Clock` |
| Unit (login ordering) | Exactly one `verify` call on every credential path; no `verify` when limited or blocked; failures recorded only on mismatch | Port fakes that record calls; rewrite U7's M1/M2 mutations as RED tests |
| Unit (limiter) | Window rollover, threshold crossing sets `blocked_until`, block expiry, reset on success, per-scope policies | Injected `Clock` advanced across window and block edges; no real time |
| Integration | TypeORM repositories, UnitOfWork, outbox `SKIP LOCKED`, migration reversibility (up → down → up, including `AppEmailLinkUrls`), `SmtpEmailSender` (ADR 25) | Testcontainers Postgres, `DataSource.runMigrations()` in setup, truncation between tests; Testcontainers Mailpit for the SMTP adapter |
| Integration (concurrency) | N parallel refreshes of one token: exactly one consume wins and the session ends revoked. N parallel `hit`s on one key: final `count` = N and `blocked_until` is set once. A rolled-back UoW leaves counter increments in place | Real Postgres, `Promise.all` over separate connections, fixed `Clock` |
| E2E | Login, refresh, reuse, logout, confirm by POST, forgot and reset with session revocation, `/me`, origin binding (wrong-app Origin gives `invalid_client`; no Origin passes), identical bodies for limited, blocked and wrong-password logins, `429` with `Retry-After` on IP-limited signup (identical for new and existing emails), `trust proxy` (spoofed `X-Forwarded-For` ignored when `false`), `GET /`, prefix layout | supertest on the shared `configureApp` factory, a fake `EmailSender` that captures links (asserting the `#token=` form), a fixed test RSA key, low `ABUSE_*` thresholds via config override |

U1 installs the runner (`npm test`). Then `openspec/config.yaml` is updated to `tdd: true` with `test_command`, and **strict TDD applies to every later task**.

## Migration / Rollout

TypeORM migrations create the schema (`npm run migration:run`), and the deploy pipeline runs them before the app starts. Rollback is `npm run migration:revert`, which reverts one migration per run through its `down()`. Revision 2 adds four migrations. Timestamps follow merge order, so a fresh database and an upgraded one run them identically: `1760000004000-AppEmailLinkUrls` (ADR 39), `1760000005000-CreateAbuseCounters` (`UNLOGGED`, ADR 36), `1760000006000-CreateAuthSessions` (`auth_sessions` and `refresh_tokens`, ADR 35), and `1760000007000-RetentionIndexes` (indexes for the retention job, ADR 35). The `authorization_codes` migration from the U7 branches is discarded and never reaches `develop`. Existing dev apps need one `app update` with both email URLs before signup or forgot works for them. Behind a load balancer, set `TRUST_PROXY` before go-live (ADR 37). The pilot app switches to the direct login behind its own feature flag; rollback is to turn the flag off and revert the migrations. If a key is compromised, follow ADR 9's emergency path and revoke all sessions (`UPDATE auth_sessions SET revoked_at`).

Branch flow (ADR 23): `main` (welcome commit) → `develop` → PR U1b, PR U1 … PR U10, each one targeting and merged into `develop` in order (U1b first, then `develop` is merged into `feat/u1-bootstrap`). Nothing targets `main` except promotions from `develop`.

## Open Questions

No blocking questions. The revision 2 assumptions were reconciled with the specs (see "Spec/Design reconciliation" in `tasks.md`):

- [x] Login never returns `429` (generic `401`). IP-only limits on signup, resend, forgot and reset return `429` with `Retry-After`; per-account email caps stay silent (ADR 36).
- [x] The `account-exists` notice links to `password_reset_url` with no token (ADR 39).
- [x] Password change revokes ALL sessions, including the current one; the SPA logs in again (ADR 35).
- [x] Refresh reuse grace window (round 11, replaces "no grace window"): about 10 s, same client IP, once per rotated token, successor revoked and a fresh pair issued in the same session; configurable (ADR 35). Clients still serialize refresh.
- [x] Round 11 contract rules (error body, `/me` fields, change-password `400`, forgot for unconfirmed accounts, `refresh_ip` and `confirm_ip` limits, preflight headers, email URL origins, issuer and JWKS URL) are fixed in ADR 36, 38, 39 and 43.

Closed in round 3:

- argon2id vs bcrypt: bcrypt cost 12 confirmed (ADR 10).
- SendGrid vs SES: generic SMTP via Nodemailer (ADR 17). Hosting target no longer affects the email choice.
- Duplicate-signup notice (conflict 3): a duplicate signup returns the same response as a successful one, and the existing owner gets the `account-exists` template ("signup attempt" notice). The template says someone tried to register with this address, suggests logging in or resetting the password, and carries no token. Any link in it is built from `AUTH_PUBLIC_BASE_URL`. Revised in round 4 to deep-link to the hosted forgot page (ADR 26); **revised again in revision 2: links to the app's `password_reset_url` with no token**, because Auth has no pages (ADR 39). The email is queued through the outbox in the same transaction as a normal signup, so timing matches.
