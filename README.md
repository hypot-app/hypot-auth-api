# hypot-auth-api

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
  --post-reset-redirect-uri https://spa.example/login
docker compose run --rm api dist/cli.js app create --name "Backend" --type confidential
docker compose run --rm api dist/cli.js app update <client_id> --clear-post-reset-redirect-uri
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

CORS for the API allows a request's `Origin` when it exactly matches `--origin` of any active app. No
`client_id` is needed, so preflights and bearer-only calls such as `/api/v1/me` work. Answers are cached
for 30 seconds, so deactivating an app or changing its origins can take that long to apply.

### Transactional email

Emails go through a Postgres outbox and a background worker started by `main.ts`. Delivery uses plain SMTP
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`/`SMTP_PASS`, `MAIL_FROM`); an app's `--email-from` overrides
`MAIL_FROM`. In the Compose stack mail is caught by Mailpit: open http://localhost:8025. Every link is
`AUTH_PUBLIC_BASE_URL` + `/api/v1/...`. Default templates live in `src/transactional-email/templates/default/`;
put files with the same names in `templates/<client_id>/` to override them for one app. The build copies the
templates into `dist/`.

TODO(U6): pass the token TTL to the templates as a variable. The confirmation template hard-codes
"24 hours", which matches the confirmation token TTL in `user-accounts/domain/one-time-token.ts`, and the
password-reset template hard-codes "1 hour" until U6 adds that flow.

### Accounts

Accounts are per app: unique on `(app_id, email)`, email stored lowercase. Passwords are bcrypt cost 12,
8 characters minimum and 72 UTF-8 bytes maximum (bcrypt ignores the rest), no NUL character.

```bash
curl -X POST localhost:3000/api/v1/accounts/signup -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com","password":"correct horse"}'   # 202, email in Mailpit
curl 'localhost:3000/api/v1/accounts/confirm?token=<token from the email>'                   # 200 once, then 400
curl -X POST localhost:3000/api/v1/accounts/resend-confirmation -H 'content-type: application/json'   -d '{"client_id":"app_...","email":"ana@example.com"}'                                   # 202 always
```

Signup and resend answer the same body whether or not the address is registered. A duplicate signup sends the
owner an `account-exists` notice (no token) instead of a confirmation. Confirmation links last 24 hours, work
once, and a resend invalidates the previous one. Unconfirmed accounts cannot log in (login arrives in U7).
Residual timing difference: signup always hashes (so both paths cost one bcrypt); resend does a few more
database writes for an unconfirmed account than for an unknown one (milliseconds), and a new signup does
three more writes and one random-token call than a duplicate (about 3-10 ms against the 250 ms hash). Both
gaps are accepted until Phase 2 rate limiting.

`/api/v1/accounts/*` intentionally has no CORS: signup, confirm and resend go through the hosted UI or app
backends, not browser SPAs. Enabling it would let any registered origin drive signup and resend from browsers
(email bombing, enumeration timing). Revisit only with a product requirement for SPA-native signup, together
with rate limiting.

### Signing keys and JWKS

Access tokens are RS256 JWTs signed with a key set that is supplied as a secret and never committed
(ADR 32). The set is one JSON document: `{ "active": <private JWK>, "next": <private JWK>, "retired": [<JWK>] }`
with a `kid` on every key. Provide it in exactly one of two ways:

- `AUTH_SIGNING_KEYS_FILE`: path of a mounted file (preferred), or
- `AUTH_SIGNING_KEYS`: the JSON itself.

The service refuses to start when the set is invalid (bad JSON, missing or mismatched private key, duplicate
`kid`, RSA key under 2048 bits) or when neither or both variables are set. The error names the problem, never
the key. Only the API process reads these variables: the operator CLI (`npm run cli`) boots without them.

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
- `POST /api/v1/accounts/signup`, `GET /api/v1/accounts/confirm`, `POST /api/v1/accounts/resend-confirmation`
- Business routes are served under `/api/v1`; `/`, `/health` and `/.well-known/jwks.json` stay at the root.
