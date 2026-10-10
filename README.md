# hypot-auth-api

An API-only authentication service. It serves JSON endpoints and no pages: each consuming app builds its own
login, signup, confirm and reset screens and calls Auth directly from the browser with its `client_id`. There is
no hosted UI, no cookie and no redirect.

- Integrating an app: [`docs/integration-guide.md`](docs/integration-guide.md)
- Endpoint contract (paths, bodies, status and error codes): [`docs/api-contract.md`](docs/api-contract.md)
- Specs (current behavior): `openspec/specs/`
- Design and delivery history (archived change): `openspec/changes/archive/2026-10-09-auth-service/`

Every endpoint of the contract is implemented. The OpenAPI 3.1 description is `openapi.json`, regenerated with
`npm run openapi:generate`. Operating the service: [Operations runbook](#operations-runbook). Browser check:
[`docs/smoke-test.md`](docs/smoke-test.md). Variables to add to `.env.example`:
[`docs/env-example-additions.md`](docs/env-example-additions.md).

## Run locally with Docker

```bash
docker compose up -d --build
```

Always pass `--build` (or run `docker compose build` first). `migrate` and `api` share the local
`hypot-api:dev` image, and `up` without `--build` reuses a stale one, which runs OLD migrations and
OLD code. `docker compose run --rm migrate` fails if the image was never built, so build first:
`docker compose build && docker compose run --rm migrate`.

- API: http://localhost:3000
- Mailpit UI: http://localhost:8025 (SMTP on port 1025)
- Postgres: localhost:5432 (dev-only credentials, see `compose.yaml`)

To stop and remove containers and volumes: `docker compose down -v`.

### Production notes

With `NODE_ENV=production` the service refuses to start unless `AUTH_PUBLIC_BASE_URL` is an `https://` URL
(case-sensitive scheme). The image sets `NODE_ENV=production`, so the compose `api` service overrides it with
`NODE_ENV=development` to keep serving on `http://localhost:3000`.

`compose.yaml` is dev-only (http base URL, `NODE_ENV=development`, dev secrets, dev keygen)
and must not be used to deploy. Also note that `docker compose run api dist/cli.js` inherits development, so it
accepts `http://localhost` app URLs.

Stale `dist/`: `npm run build` and `npm run start:dev` now remove `dist/` first. If you ran a migration from a
stale `dist/` that applied `CreateAuthorizationCodes` (a discarded branch), recreate the local database with
`docker compose down -v`.

Database pool: the service keeps at most 10 connections (`DB_POOL_MAX` in `src/platform/persistence/typeorm.options.ts`,
a code constant, not an environment variable) and waits at most 5000 ms for a free one (`DB_CONNECTION_TIMEOUT_MS`).
When the pool is exhausted a request fails with a connection timeout error instead of hanging the API forever. The
abuse counters use their own connection outside any transaction, so they are never counted inside a unit of work.

### Migrations in containers

The runtime image is distroless (no npm, no shell), so `npm run migration:*` is not available
inside it. Compose runs a one-shot `migrate` service (same image, `node_modules/typeorm/cli.js`)
and the `api` waits for it to finish successfully. A second `docker compose up` finds nothing
pending. The app never migrates on startup.

```bash
docker compose run --rm migrate    # apply pending migrations
docker compose run --rm migrate node_modules/typeorm/cli.js migration:revert -d dist/platform/persistence/data-source.js
```

### Managing apps (operator CLI)

Apps are managed only through the CLI; there are no HTTP endpoints for it. Inside the image it
runs with the image's own node (it needs the same environment variables as the api):

```bash
docker compose run --rm api dist/cli.js app create --name "My SPA" \
  --redirect-uri https://spa.example/cb --origin https://spa.example \
  --email-confirmation-url https://spa.example/confirm \
  --password-reset-url https://spa.example/reset
docker compose run --rm api dist/cli.js app create --name "Backend" --type confidential \
  --origin https://backend.example \
  --email-confirmation-url https://backend.example/confirm \
  --password-reset-url https://backend.example/reset
docker compose run --rm api dist/cli.js app update <client_id> --name "New name"
docker compose run --rm api dist/cli.js app deactivate <client_id>
```

A confidential app's `client_secret` is printed once, at creation; only its hash is stored.
Repeated `--redirect-uri` / `--origin` options on `update` replace the stored list.
Without Docker, use `node dist/cli.js app ...` after `npm run build`.

`client_id` has the form `app_` followed by 32 lowercase hex characters (it never starts with `-`).

Registration validates app fields and rejects bad input with a non-zero exit and nothing stored:

- `--origin` must be an origin only: `https://host[:port]` (or `http://localhost` / `http://127.0.0.1` outside
  production). No path, query, fragment, trailing slash, `null` or wildcard. Scheme and host are lower-cased.
- `--redirect-uri` must be an absolute `https` URL (or `http` on localhost outside production) without a fragment.
- `--email-confirmation-url` and `--password-reset-url` are required on `create`: the pages of the app that the
  emails link to (the token is appended as `#token=...`). Same rules as redirect URIs (https, or `http` on localhost
  outside production, no credentials, no fragment), and the **origin of each URL must be one of the app's `--origin`
  values** (compared after normalization), so `create` needs at least one `--origin`. `update` can replace them but never clear them, and it also fails if it
  removes an origin that a stored URL still uses. An unknown option, such as the removed
  `--post-reset-redirect-uri`, exits non-zero.

Apps created before these URLs existed need one `app update <client_id> --email-confirmation-url ... --password-reset-url ...`
(with both origins already in `--origin`) before signup or forgot-password works for them.

CORS is bound to the calling app. A preflight is answered (`204`) when the origin belongs to any active app,
with `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization`,
`Access-Control-Max-Age: 600` and `Vary: Origin`. The actual request is allowed only when its `Origin` exactly
matches `--origin` of the app it identifies (body `client_id`, the token's owner for confirm and reset, the
access token's `aud` for `/api/v1/me` and password change). Auth never sends credentials headers or cookies.
Answers are cached for 30 seconds, so deactivating an app or changing its origins can take that long to apply.
The binding and the fixed preflight header set are live on all ten API routes.

The origin of an app's `email_confirmation_url` and `password_reset_url` must be one of its allowed origins,
otherwise its confirm and reset screens could not call Auth. The CLI enforces this on create and update.

### Transactional email

Emails go through a Postgres outbox and a background worker started by `main.ts`. Delivery uses plain SMTP
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`/`SMTP_PASS`, `MAIL_FROM`); an app's `--email-from` overrides
`MAIL_FROM`. In the Compose stack mail is caught by Mailpit: open http://localhost:8025. Links point to the
app's own screens, never to a page hosted by Auth: `<email_confirmation_url>#token=<token>` and
`<password_reset_url>#token=<token>`, with the token in the fragment so it never reaches servers or logs. The
account-exists notice links to `password_reset_url` with no token. `AUTH_PUBLIC_BASE_URL` is only the token issuer
(`iss`) and the base of the JWKS URL. An app that predates the URLs has none: its
confirmation, reset and account-exists emails are marked `failed` (the reason names the missing field) instead of
being sent with a broken link.
Default templates live in `src/transactional-email/templates/default/`;
put files with the same names in `templates/<client_id>/` to override them for one app. The build copies the
templates into `dist/`.

The default confirmation template says the link is valid for 24 hours and the password-reset template says 1 hour.
These numbers are the token lifetimes in `TOKEN_TTL_HOURS` (`user-accounts/domain/one-time-token.ts`); a test pins
the wording to that table, so changing a lifetime fails until the templates are updated. A per-app override
template carries its own wording and must follow the same lifetimes.

### Accounts

Accounts are per app: unique on `(app_id, email)`, email stored lowercase. Passwords are bcrypt cost 12,
8 characters minimum and 72 UTF-8 bytes maximum (bcrypt ignores the rest), no NUL character.

```bash
curl -X POST localhost:3000/api/v1/accounts/signup -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com","password":"correct horse"}'   # 202, email in Mailpit
curl -X POST localhost:3000/api/v1/accounts/resend-confirmation -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com"}'                                   # 202 always
# Confirm is a POST with the token from the email link fragment (GET /api/v1/accounts/confirm is 404 and never consumes a token):
curl -X POST localhost:3000/api/v1/accounts/confirm -H 'content-type: application/json' -d '{"token":"<token>"}'   # 200 {"message"} once, then 400
```

Signup and resend answer the same fixed body whether or not the address is registered. A duplicate signup sends
the owner an `account-exists` notice (no token) instead of a confirmation. Confirmation links last 24 hours, work
once, and a resend invalidates the previous one. Unconfirmed accounts cannot log in.
Residual timing difference: signup always hashes (so both paths cost one bcrypt); resend does a few more
database writes for an unconfirmed account than for an unknown one (milliseconds), and a new signup does
three more writes and one random-token call than a duplicate (about 3-10 ms against the 250 ms hash). Both
gaps are accepted and bounded by the per-IP (`email_ip`) and per-account (`email_account`) limits.

Signup, confirm and resend are called by app frontends from the browser, so they follow the origin-bound CORS
rules above (signup and resend are bound to `client_id`; confirm is bound to the app that owns the token). They are
rate limited per IP (`429` with `Retry-After`) and per target account (silent cap, 3 emails per hour). The "no CORS on accounts" rule of the hosted-UI design is gone: Auth has no
hosted UI.

### Abuse protection

Rate limits and the login lockout count in Postgres (`abuse_counters`, an UNLOGGED table, no Redis); a sweeper
started by `main.ts` deletes expired rows every 5 minutes (retention of the other tables: see the runbook). Each scope has `ABUSE_<SCOPE>_LIMIT` and
`ABUSE_<SCOPE>_WINDOW_SECONDS` (plus `_BLOCK_SECONDS` for `LOGIN_ACCOUNT_IP` and `LOGIN_ACCOUNT`). Defaults:
`LOGIN_IP` 100 per 15 min, `LOGIN_ACCOUNT_IP` 5 per 15 min, `LOGIN_ACCOUNT` 50 per 1 h (both lockouts last 15 min),
`EMAIL_IP`, `RESET_IP` and `CONFIRM_IP` 20 per 1 h, `REFRESH_IP` 60 per 15 min, `EMAIL_ACCOUNT` 3 per 1 h.
The client IP is the TCP peer unless `TRUST_PROXY` (default `false`: a hop count, or a comma-separated list of
`loopback`, `linklocal`, `uniquelocal`, IPs or CIDRs; `true` is rejected; a hop count is 1 to 10 and a CIDR no wider than /8 for IPv4 or
/16 for IPv6) names the proxies in front of Auth. Behind a load balancer set it, or every user shares the proxy's
address. Set it exactly: too FEW hops only over-limits, but too MANY lets a client-supplied `X-Forwarded-For` value win. IPv6 clients are keyed on their /64. If the counter store fails,
credential endpoints answer `503 temporarily_unavailable` (logged once a minute at most, with the scope and driver message only), and the `429` and `503` answers are readable from an active app's origin. The login lockout counts the attempt before bcrypt (`beginLoginAttempt`), so parallel guesses cannot outrun it. The account limit is 50 attempts per window; reaching it locks the account for 15 min, and when the lock ends the count restarts. A distributed attacker therefore gets at most about 200 attempts per hour per account, and needs at least 10 distinct IPs for it, because each account and IP pair is capped at about 20 attempts per hour (5 per lock cycle of 15 min). Password change (U18) shares these counters. Both counters count attempts, so a service account or automation that logs in more than 50 times an hour locks itself out; it must reuse its refresh token instead of logging in again. Every credential endpoint calls the guard.

### Sessions and refresh tokens

Login opens a session (a refresh-token family, bound to the app and the account). The refresh token is 256 bits of
CSPRNG output, shown once and stored only as its SHA-256. `REFRESH_ABSOLUTE_TTL_SECONDS` (default 2592000, 30 days)
is the session lifetime from login, and `REFRESH_IDLE_TTL_SECONDS` (default 604800, 7 days) is how long a token
lives without use, capped at the session end. Both are positive integers of at most 2147483647; an invalid value
stops the app at boot. `POST /api/v1/auth/refresh` rotates the token: the old one is marked used and a new one is
issued in the same session, which never outlives its absolute end. Presenting a used or revoked token revokes the
whole session (`reuse_detected`), with one exception, the reuse grace window: a rotated token presented again within
`REFRESH_REUSE_GRACE_SECONDS` (default 10, `0` disables it; a non-negative integer of at most 2147483647) of its
rotation, from the same client IP (IPv6 on its /64), at most once, while its successor is still unused, gets a fresh
pair in the same session and the successor is revoked. It covers a lost response, not racing tabs, and it assumes
`TRUST_PROXY` is set correctly: behind a proxy that hides client addresses every client looks like one IP and the
window then forgives a thief too. `POST /api/v1/auth/logout` revokes the session of the presented token (reason
`logout`) and always answers `204`, whether the token is active, used, expired, unknown or another app's. It revokes
only when the token belongs to the client's app and any `Origin` is bound to it. Access tokens already issued stay
valid until `exp`. `refresh_ip` limits refresh (60 per 15 minutes per app and IP by default); logout has no limiter.

### Signing keys and JWKS

Access tokens are RS256 JWTs signed with a key set that is supplied as a secret and never committed
(ADR 32). The set is one JSON document: `{ "active": <private JWK>, "next": <private JWK>, "retired": [<JWK>] }`
with a `kid` on every key. Provide it in exactly one of two ways:

- `AUTH_SIGNING_KEYS_FILE`: path of a mounted file (preferred), or
- `AUTH_SIGNING_KEYS`: the JSON itself.

The service refuses to start when the set is invalid (bad JSON, missing or mismatched private key, duplicate
`kid`, RSA key under 2048 bits) or when neither or both variables are set. The error names the problem, never
the key. Only the API process reads these variables: the operator CLI (`npm run cli`) boots without them.

The JWKS URL is `${AUTH_PUBLIC_BASE_URL}/.well-known/jwks.json` and `iss` is exactly `AUTH_PUBLIC_BASE_URL`, so
set it without a trailing slash (for example `https://auth.example`).

`GET /.well-known/jwks.json` (root, no prefix) publishes the public half of `active`, `next` and the
non-expired `retired` keys with `Cache-Control: public, max-age=300`. Private parameters are never published.

**Dev keys only.** `npm run keys:generate` and the compose `keygen` service are for development: they write a
throwaway set (the compose one lives in the `signing_keys` volume; `docker compose down -v` discards it, and
the generated file is gitignored). Without Docker run `npm run keys:generate`, which leaves an existing file
untouched, then add `AUTH_SIGNING_KEYS_FILE=.keys/signing-keys.json` to your `.env`. **Production keys come
from a secret manager** that mounts the JSON at the same kind of path and is pointed to by
`AUTH_SIGNING_KEYS_FILE`; never run the generator against production.

Tokens carry `typ: at+jwt` and `kid` (header, RFC 9068) and `iss`, `aud` (the app's `client_id`), `sub`, `iat`, `exp` (one hour), `jti`;
roles are the apps' business. The issuer is `AUTH_PUBLIC_BASE_URL`. A consumer validates offline: fetch JWKS, pick
the key by `kid`, accept only `RS256` and `typ: at+jwt`, check `iss`, its own `aud` and `exp`. The service's own verifier does the
same with a 5 second clock tolerance, accepts any published key (active, next, retired), and refuses unknown or
missing `kid`, other algorithms (including `none` and HS256) and tokens over 4096 characters, always with the
same generic `invalid_token` error.

Rotation is a config change and needs a restart of every instance:

1. Add the new key as `next` and deploy. The timer starts only when ALL instances serve `next`.
2. Wait at least 15 minutes (1 hour recommended). Consumers cache the JWKS: the endpoint says 5 minutes, but
   jose's remote JWKS cache defaults to 10 minutes and ignores `Cache-Control`; proxies add more.
3. Promote: move `next` to `active` and the old `active` to `retired`, adding `"retiredAt": "<ISO timestamp>"`
   to the retired entry.
4. The retired key is published until `retiredAt` plus the retention window of 1 hour + 5 s clock tolerance +
   10 minutes jose cache (4205 s). At the next boot after that it is dropped and a warning names its `kid`;
   remove the entry from the secret. A retired key without `retiredAt` never expires and logs a boot warning.

Emergency rotation also revokes all refresh tokens, with the operator CLI:

```bash
docker compose run --rm api dist/cli.js ops:revoke-all --yes
```

It ends every open session of every app (reason `ops_revoke_all`), prints `revoked sessions: <count>` and refuses
to run without `--yes`. It needs no signing key. Access tokens already issued stay valid until `exp`, which is why
the key is rotated as well. Every user logs in again.

## Run locally without Docker

Requires Node 24 (see `.nvmrc`).

```bash
cp .env.example .env               # use localhost hosts: DATABASE_URL @localhost:5432, SMTP_HOST=localhost
docker compose up -d postgres mailpit
npm ci
npm run keys:generate        # dev-only signing keys, then set AUTH_SIGNING_KEYS_FILE in .env (see Signing keys)
npm run migration:run              # builds, then applies pending migrations
npm run start:dev                  # recompiles and restarts on changes
```

`npm start`, `npm run cli` and the `migration:*` scripts load `.env` automatically when it exists
(`node --env-file-if-exists`). In Docker and CI no `.env` is needed; variables are injected.
`start:dev` recompiles TypeScript on change; editing `.hbs` templates requires restarting it.

The service validates its environment at startup and exits with a clear error when a
required variable is missing or invalid (see `.env.example`).

## Operations runbook

Answers first: deploy by running the migrations, then the app; scale by adding replicas; the only state to protect is Postgres and the signing key secret.

| Task | How |
|------|-----|
| Apply migrations | `docker compose run --rm migrate` (or `npm run migration:run` without Docker), before starting the new version. The app never migrates on startup. |
| Roll a migration back | `migration:revert` undoes one migration per run through its `down()`. A test applies the whole chain, reverts it to an empty schema and applies it again. |
| Revoke every session | `ops:revoke-all --yes` (see Signing keys and JWKS). |
| Rotate signing keys | The rotation steps in Signing keys and JWKS. |
| Regenerate the API description | `npm run openapi:generate` writes `openapi.json`. It is a build artifact: no route serves it, and a test fails when it is stale. |
| Check the browser flow | `docs/smoke-test.md`. |
| Check login latency | `scripts/login-load.mjs`, see Capacity and load test. |

### Background jobs and retention

`main.ts` starts three timers, and nothing else does: the CLI, the migration job and the tests never run them. Each replica runs its own copy, which is safe: the outbox claims rows with `FOR UPDATE SKIP LOCKED`, and the sweepers only delete, so two replicas at most contend briefly on the same batch. On SIGTERM each job stops scheduling and finishes the batch in flight before the pool closes, so give the container the stop grace period of the compose file (70 s, bounded by the 60 s email send deadline).

| Job | Runs | Does |
|-----|------|------|
| Outbox poller | every 2 s | Sends queued email through SMTP, with backoff, 8 attempts, then `failed` |
| Counter sweeper | at start, then every 5 min | Deletes `abuse_counters` rows whose window and lockout have ended |
| Retention sweeper | at start, then every hour | Deletes the rows below, in batches of 1,000 until a batch comes back short |

Retention windows (ADR 35). Each delete is a single statement on its own pool connection, never inside a transaction.

| Data | Deleted when | Why this long |
|------|--------------|---------------|
| Sessions and their refresh tokens | 1 day after the session's `expires_at` | Consumed tokens of a live session are kept on purpose: presenting one is reuse detection. A session revoked early is kept until its expiry plus a day |
| `one_time_tokens` (confirmation and reset) | 1 day after `expires_at`, consumed or not | Short-lived by nature (24 h and 1 h) |
| `email_outbox`, status `sent` or `failed` | 7 days after `created_at` | Time to investigate a delivery problem |
| `email_outbox`, status `pending` | never | It is the live queue |
| `abuse_counters` | when expired (counter sweeper) | A finished window has no value |
| `users`, `apps` | never | Not in scope for Phase 1 |

A failing sweep logs `retention sweep of <sessions|one-time tokens|outbox> failed: <driver message>` (message only) and the next hour tries again; the other categories still run.

### Deploying behind a load balancer

| Setting | Rule |
|---------|------|
| `AUTH_PUBLIC_BASE_URL` | In production an `https` URL with no trailing slash, no query and no fragment, for example `https://auth.example`. It is copied verbatim into every token's `iss`, and the JWKS URL is built from it. The service refuses to start with anything else. |
| `TRUST_PROXY` | Set it to the hop count or the proxy CIDRs in front of Auth (default `false`). Left unset behind a load balancer, every client shares the proxy's address, so one user can exhaust an IP limit for everyone. Set too high, a client-supplied `X-Forwarded-For` wins. The reuse grace window also relies on it. |
| Counters | `abuse_counters` is an `UNLOGGED` table: fast, but not crash-safe and not replicated. After a crash or a failover to a standby it is empty and every window and lockout starts over. That only forgives, it never blocks. |

### Capacity and load test

Login is CPU-bound by bcrypt cost 12. Signup, reset and change hash too, and a login for an unknown email hashes a dummy so timing does not leak. Requests that a limit or lockout rejects skip the hash.

| Fact | Number |
|------|--------|
| One bcrypt cost-12 hash | about 250 ms of one CPU core |
| libuv threadpool (`UV_THREADPOOL_SIZE`, default 4) | 4 hashes at once, so about **16 logins per second per process** |
| More threads than cores | No gain. Set `UV_THREADPOOL_SIZE` to the container's core count (ADR 12) |
| Scaling | Horizontal: add replicas. About 16 logins per second each, so 1,000 per second needs about 63 processes of 4 cores |
| Database connections | Each process keeps at most 10 (`DB_POOL_MAX`, a code constant). **Replicas times 10 must fit in Postgres `max_connections`**, minus a reserve for migrations and operators. The default of 100 allows about 9 replicas |
| Many replicas | Put PgBouncer in front. Auth keeps no session-level state (no advisory locks, `LISTEN` or session `SET`), but it has not been load-tested through PgBouncer: verify it in staging |
| Pool exhausted | A caller waits 5000 ms for a connection (`DB_CONNECTION_TIMEOUT_MS`). On the counter path (every credential endpoint) the answer is `503 temporarily_unavailable`; elsewhere it is a `500`. The pool recovers when the load drops |

The gate (ADR 12): login P95 under 500 ms at pilot load. Run it by hand against a running instance. Use a dedicated or staging instance, a confirmed account, and raise the login limits for the run, because one account from one address is blocked after 5 attempts by design and a blocked login is fast, which would fake a pass. The script fails when any answer is not `200` for that reason.

```bash
# Instance started with ABUSE_LOGIN_IP_LIMIT, ABUSE_LOGIN_ACCOUNT_IP_LIMIT and ABUSE_LOGIN_ACCOUNT_LIMIT raised (for example to 100000).
LOAD_PASSWORD='the account password' node scripts/login-load.mjs \
  --client-id app_0123456789abcdef0123456789abcdef --email load@example.com \
  --url http://localhost:3000 --requests 200 --concurrency 4
```

It prints throughput, the status counts and min, median, P95, P99 and max latency, then `GATE PASSED` (exit 0) or `GATE FAILED` (exit 1; exit 2 for bad arguments). Set `--concurrency` to the number of logins your pilot expects at the same moment and `--threshold-ms` only to tighten the gate. The pilot load figure is a product decision that this repository does not fix.

## Endpoints

- `GET /` welcome message
- `GET /health` liveness plus database ping (200, or 503 when the database is down)
- `GET /.well-known/jwks.json` public signing keys (see Signing keys and JWKS)
- Implemented: `GET /api/v1/me` (bearer access token, `{id, email, email_verified, created_at}`, one generic `401 invalid_token`), `POST /api/v1/accounts/signup`, `POST /api/v1/accounts/confirm` (`{token}`; the old `GET` answers `404`),
  `POST /api/v1/accounts/resend-confirmation`, `POST /api/v1/auth/login`,
  `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`
  (login takes JSON `{client_id, email, password}`, one generic `401`, never `429`)
- Implemented: `POST /api/v1/password/forgot` (always a generic `202`), `POST /api/v1/password/reset` (`{token, new_password}`, `204`, revokes every session), `POST /api/v1/password/change` (bearer plus `{current_password, new_password}`, `204`, a wrong current password is `400 invalid_current_password`). Full list and
  contract: [`docs/api-contract.md`](docs/api-contract.md).
- Business routes are served under `/api/v1`; `/`, `/health` and `/.well-known/jwks.json` stay at the root.
