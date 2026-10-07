# hypot-auth-api

An API-only authentication service. It serves JSON endpoints and no pages: each consuming app builds its own
login, signup, confirm and reset screens and calls Auth directly from the browser with its `client_id`. There is
no hosted UI, no cookie and no redirect.

- Integrating an app: [`docs/integration-guide.md`](docs/integration-guide.md)
- Endpoint contract (paths, bodies, status and error codes): [`docs/api-contract.md`](docs/api-contract.md)
- Design and specs: `openspec/changes/auth-service/`

Only part of the API is implemented so far (see the status badges in the contract). Sections below that describe
planned behaviour say so.

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

`compose.yaml` is dev-only (http base URL, `NODE_ENV=development`, non-Secure cookies, dev secrets, dev keygen)
and must not be used to deploy. Also note that `docker compose run api dist/cli.js` inherits development, so it
accepts `http://localhost` app URLs.

Stale `dist/`: `npm run build` and `npm run start:dev` now remove `dist/` first. If you ran a migration from a
stale `dist/` that applied `CreateAuthorizationCodes` (a discarded branch), recreate the local database with
`docker compose down -v`.

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
  --redirect-uri https://spa.example/cb --origin https://spa.example
docker compose run --rm api dist/cli.js app create --name "Backend" --type confidential
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
The binding and the preflight header set land in U11c and U17a (planned); today the middleware still allows any
active app's origin on the legacy route list.

The origin of an app's `email_confirmation_url` and `password_reset_url` must be one of its allowed origins,
otherwise its confirm and reset screens could not call Auth. The CLI enforces this on create and update (planned,
U11b).

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

TODO(U18): pass the token TTL to the templates as a variable. The confirmation template hard-codes
"24 hours", which matches the confirmation token TTL in `user-accounts/domain/one-time-token.ts`, and the
password-reset template hard-codes "1 hour" until U18 adds that flow.

### Accounts

Accounts are per app: unique on `(app_id, email)`, email stored lowercase. Passwords are bcrypt cost 12,
8 characters minimum and 72 UTF-8 bytes maximum (bcrypt ignores the rest), no NUL character.

```bash
curl -X POST localhost:3000/api/v1/accounts/signup -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com","password":"correct horse"}'   # 202, email in Mailpit
curl -X POST localhost:3000/api/v1/accounts/resend-confirmation -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com"}'                                   # 202 always
# Confirm is a POST with the token from the email link fragment (planned, U17a). The current
# GET /api/v1/accounts/confirm?token=... is being replaced and will return 404:
#   curl -X POST localhost:3000/api/v1/accounts/confirm -H 'content-type: application/json' -d '{"token":"<token>"}'   # 200 {"message"} once, then 400
```

Signup and resend answer the same fixed body whether or not the address is registered. A duplicate signup sends
the owner an `account-exists` notice (no token) instead of a confirmation. Confirmation links last 24 hours, work
once, and a resend invalidates the previous one. Unconfirmed accounts cannot log in (login is planned, U14c).
Residual timing difference: signup always hashes (so both paths cost one bcrypt); resend does a few more
database writes for an unconfirmed account than for an unknown one (milliseconds), and a new signup does
three more writes and one random-token call than a duplicate (about 3-10 ms against the 250 ms hash). Both
gaps are accepted and bounded by the per-IP and per-account limits (planned, U13 and U17b).

Signup, confirm and resend are called by app frontends from the browser, so they follow the origin-bound CORS
rules above (signup and resend: built in U11c; confirm: planned, U17a). They are rate limited per IP (`429` with `Retry-After`) and per target account
(silent cap, 3 emails per hour). The "no CORS on accounts" rule of the hosted-UI design is gone: Auth has no
hosted UI.

### Abuse protection

Rate limits and the login lockout count in Postgres (`abuse_counters`, an UNLOGGED table, no Redis); a sweeper
started by `main.ts` deletes expired rows every 5 minutes. Each scope has `ABUSE_<SCOPE>_LIMIT` and
`ABUSE_<SCOPE>_WINDOW_SECONDS` (plus `_BLOCK_SECONDS` for `LOGIN_ACCOUNT_IP` and `LOGIN_ACCOUNT`). Defaults:
`LOGIN_IP` 100 per 15 min, `LOGIN_ACCOUNT_IP` 5 per 15 min, `LOGIN_ACCOUNT` 50 per 1 h (both lockouts last 15 min),
`EMAIL_IP`, `RESET_IP` and `CONFIRM_IP` 20 per 1 h, `REFRESH_IP` 60 per 15 min, `EMAIL_ACCOUNT` 3 per 1 h.
The client IP is the TCP peer unless `TRUST_PROXY` (default `false`: a hop count, or a comma-separated list of
`loopback`, `uniquelocal` or CIDRs; `true` is rejected; a hop count is 1 to 10 and a CIDR no wider than /8 for IPv4 or
/16 for IPv6) names the proxies in front of Auth. Behind a load balancer set it, or every user shares the proxy's
address. Set it exactly: too FEW hops only over-limits, but too MANY lets a client-supplied `X-Forwarded-For` value win. IPv6 clients are keyed on their /64. If the counter store fails,
credential endpoints answer `503 temporarily_unavailable` (logged once a minute at most, with the scope and driver message only), and the `429` and `503` answers are readable from an active app's origin. The login lockout counts the attempt before bcrypt (`beginLoginAttempt`), so parallel guesses cannot outrun it. The guard exists; U14, U17 and U18 call it from the endpoints.

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

Emergency rotation also revokes all refresh tokens.

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

## Endpoints

- `GET /` welcome message
- `GET /health` liveness plus database ping (200, or 503 when the database is down)
- `GET /.well-known/jwks.json` public signing keys (see Signing keys and JWKS)
- Implemented: `POST /api/v1/accounts/signup`, `POST /api/v1/accounts/resend-confirmation`, and the legacy
  `GET /api/v1/accounts/confirm` (being replaced by `POST /api/v1/accounts/confirm`)
- Planned: `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `GET /api/v1/me`,
  `POST /api/v1/password/forgot`, `POST /api/v1/password/reset`, `POST /api/v1/password/change`. Full list and
  contract: [`docs/api-contract.md`](docs/api-contract.md).
- Business routes are served under `/api/v1`; `/`, `/health` and `/.well-known/jwks.json` stay at the root.
