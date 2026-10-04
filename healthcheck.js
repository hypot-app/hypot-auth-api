// Container healthcheck: distroless has no shell, curl or wget.
const url = `http://127.0.0.1:${process.env.PORT || 3000}/`;

fetch(url, { signal: AbortSignal.timeout(2500) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
