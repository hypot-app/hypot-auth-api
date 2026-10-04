# hypot-auth-api

## Run locally with Docker

```bash
docker compose up --build
```

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

CORS for the API is decided per app from `--origin`: send `client_id` in the URL query string
(preflight requests carry no body) on cross-origin calls.

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
