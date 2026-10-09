# Lines to paste into `.env.example`

The agents that implement this repository never read or edit `.env*` files, so the maintainer pastes this block by hand. It lists every variable the service reads, taken from the schemas in code. Skip any line that `.env.example` already has with the same meaning.

Uncommented lines are required. Commented lines are optional and show the built-in default, so uncommenting one without changing it changes nothing.

```dotenv
# --- Runtime ---------------------------------------------------------------
# development | test | production. production requires an https AUTH_PUBLIC_BASE_URL.
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://hypot:hypot_dev_only@localhost:5432/hypot

# --- Issuer ----------------------------------------------------------------
# Copied verbatim into every token's `iss`; the JWKS URL is ${AUTH_PUBLIC_BASE_URL}/.well-known/jwks.json.
# Absolute http(s) URL, no trailing slash, no query, no fragment. https only in production.
AUTH_PUBLIC_BASE_URL=http://localhost:3000

# --- Email (SMTP) ----------------------------------------------------------
SMTP_HOST=localhost
SMTP_PORT=1025
# SMTP_SECURE=false
# SMTP_USER and SMTP_PASS: set both or neither.
# SMTP_USER=
# SMTP_PASS=
MAIL_FROM=no-reply@hypot.local

# --- Signing keys ----------------------------------------------------------
# Set EXACTLY ONE of the two. Dev: `npm run keys:generate`, then point the file variable at the output.
AUTH_SIGNING_KEYS_FILE=.keys/signing-keys.json
# AUTH_SIGNING_KEYS={"active":{...},"next":{...},"retired":[...]}

# --- Reverse proxy ---------------------------------------------------------
# false | hop count 1-10 | comma-separated loopback, linklocal, uniquelocal, IPs or CIDRs (no wider than /8 IPv4, /16 IPv6).
# `true` is rejected. Set it exactly when a load balancer sits in front, or every client shares one address.
# TRUST_PROXY=false

# --- Abuse limits (ADR 36). All positive integers; the value shown is the default. ---------------
# ABUSE_LOGIN_IP_LIMIT=100
# ABUSE_LOGIN_IP_WINDOW_SECONDS=900
# ABUSE_LOGIN_ACCOUNT_IP_LIMIT=5
# ABUSE_LOGIN_ACCOUNT_IP_WINDOW_SECONDS=900
# ABUSE_LOGIN_ACCOUNT_IP_BLOCK_SECONDS=900
# ABUSE_LOGIN_ACCOUNT_LIMIT=50
# ABUSE_LOGIN_ACCOUNT_WINDOW_SECONDS=3600
# ABUSE_LOGIN_ACCOUNT_BLOCK_SECONDS=900
# ABUSE_EMAIL_IP_LIMIT=20
# ABUSE_EMAIL_IP_WINDOW_SECONDS=3600
# ABUSE_RESET_IP_LIMIT=20
# ABUSE_RESET_IP_WINDOW_SECONDS=3600
# ABUSE_CONFIRM_IP_LIMIT=20
# ABUSE_CONFIRM_IP_WINDOW_SECONDS=3600
# ABUSE_REFRESH_IP_LIMIT=60
# ABUSE_REFRESH_IP_WINDOW_SECONDS=900
# ABUSE_EMAIL_ACCOUNT_LIMIT=3
# ABUSE_EMAIL_ACCOUNT_WINDOW_SECONDS=3600

# --- Sessions (ADR 35). Seconds, at most 2147483647. -------------------------
# REFRESH_IDLE_TTL_SECONDS=604800
# REFRESH_ABSOLUTE_TTL_SECONDS=2592000
# A rotated refresh token presented again inside this window, once, from the same IP, is forgiven. 0 disables it.
# REFRESH_REUSE_GRACE_SECONDS=10

# --- Capacity (Node, not Auth) ----------------------------------------------
# bcrypt runs on the libuv threadpool (default 4 threads). Set it to the number of CPU cores of the container.
# UV_THREADPOOL_SIZE=4
```

## Where each group comes from

| Group | Source of truth |
|-------|-----------------|
| Runtime, issuer, SMTP, proxy | `src/platform/config/app-config.ts` (`envSchema`) |
| Signing keys | `src/token-lifecycle/infrastructure/signing-keys-source.ts` |
| Abuse limits | `src/abuse-protection/infrastructure/abuse-config.ts` (`ABUSE_<SCOPE>_<FIELD>`, `_BLOCK_SECONDS` only for the two login lockout scopes) |
| Sessions | `src/session-auth/infrastructure/session-config.ts` |
| Pool size and acquisition timeout | Not variables: `DB_POOL_MAX` and `DB_CONNECTION_TIMEOUT_MS` are constants in `src/platform/persistence/typeorm.options.ts` |

An invalid value stops the process at boot with the variable name and the rule, never the value.
