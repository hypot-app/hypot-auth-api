# hypot-auth-api

## Run locally with Docker

```bash
docker compose up --build
```

- API: http://localhost:3000
- Mailpit UI: http://localhost:8025 (SMTP on port 1025)
- Postgres: localhost:5432 (dev-only credentials, see `compose.yaml`)

To stop and remove containers and volumes: `docker compose down -v`.

## Run locally without Docker

Requires Node 24 (see `.nvmrc`).

```bash
cp .env.example .env   # then start Postgres (e.g. docker compose up -d postgres mailpit)
npm ci
npm run build
node --env-file=.env dist/main.js
```

The service validates its environment at startup and exits with a clear error when a
required variable is missing or invalid (see `.env.example`).

## Endpoints

- `GET /` welcome message
- `GET /health` liveness plus database ping (200, or 503 when the database is down)
- Business routes are served under `/api/v1`; `/`, `/health` and `/.well-known/jwks.json` stay at the root.
