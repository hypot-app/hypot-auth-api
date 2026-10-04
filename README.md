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

## Run locally without Docker

Requires Node 24 (see `.nvmrc`).

```bash
cp .env.example .env   # then start Postgres (e.g. docker compose up -d postgres mailpit)
npm ci
npm run build
npm run migration:run   # apply pending migrations (uses DATABASE_URL)
node --env-file=.env dist/main.js
```

The service validates its environment at startup and exits with a clear error when a
required variable is missing or invalid (see `.env.example`).

## Endpoints

- `GET /` welcome message
- `GET /health` liveness plus database ping (200, or 503 when the database is down)
- Business routes are served under `/api/v1`; `/`, `/health` and `/.well-known/jwks.json` stay at the root.
