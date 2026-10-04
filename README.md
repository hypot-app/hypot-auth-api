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
npm ci
npm run build
npm start
```
