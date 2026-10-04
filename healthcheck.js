// Container healthcheck: distroless has no shell, curl or wget.
// /health pings the database, so an unhealthy container means a broken dependency.
const url = `http://127.0.0.1:${process.env.PORT || 3000}/health`;

fetch(url, { signal: AbortSignal.timeout(2500) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
