# App Registry Specification

## Purpose

Defines first-class client applications (apps) that the Auth service serves. Every account, token, and email is scoped to exactly one app. Auth is API-only: apps supply their own UI, and the registry holds the URLs Auth needs to reach it from emails.

## Requirements

### Requirement: App record

The system MUST store each app with a unique `app_id`, a unique public `client_id`, a display name, a client type (`public` or `confidential`), a list of allowed origins, a required `email_confirmation_url`, a required `password_reset_url`, and email template settings. Confidential apps MUST have a client secret stored hashed. Public apps MUST NOT have a client secret. The `redirect_uris` list is no longer used (OAuth is deferred to Phase 4): it MUST NOT be consulted by any Phase 1 endpoint (assumption: the column is kept, not dropped).

#### Scenario: Register a public app
- GIVEN an operator runs the registration CLI with a name, origins, `email_confirmation_url`, `password_reset_url`, and no secret
- WHEN the app is created
- THEN the app has a generated `client_id` and type `public`
- AND no client secret exists for it

#### Scenario: Register a confidential app
- GIVEN an operator registers an app with type `confidential`
- WHEN the app is created
- THEN a client secret is shown once to the operator
- AND only its hash is persisted

### Requirement: Email link URLs

Each app MUST have an `email_confirmation_url` and a `password_reset_url`. Both MUST be supplied on create and MUST NOT be cleared or set empty on update. Each MUST be an absolute URL with scheme `https`, or `http` for `localhost` and `127.0.0.1` only when `NODE_ENV` is not `production`. Each MUST contain no userinfo and no fragment. Invalid input MUST be rejected with no change persisted. The ORIGIN of each URL (scheme, host and port, normalized as for allowed origins) MUST equal one of the app's `allowed_origins`, so the app's confirm and reset pages can call Auth from the browser. This MUST be enforced on create and on update, including an update that changes only `allowed_origins` and would leave a URL's origin unlisted. The URLs MUST come only from the app record, never from a request. Existing apps without values receive them through `update`; until then they cannot use signup or password reset (assumption).

#### Scenario: Create requires both URLs
- GIVEN an operator registers an app without `--password-reset-url`
- WHEN the CLI runs
- THEN it exits non-zero with a clear error and nothing is persisted

#### Scenario: Update replaces but never clears
- GIVEN an app with both URLs
- WHEN the operator updates one with a valid new URL
- THEN the new value is persisted
- AND an attempt to clear or blank either URL is rejected

#### Scenario: Invalid URL rejected
- GIVEN a relative URL, a `javascript:` or `ftp:` URL, a URL with userinfo or a fragment, or `http://a.example/confirm`
- WHEN the app is created or updated
- THEN the CLI rejects it and persists nothing

#### Scenario: URL origin must be an allowed origin
- GIVEN an operator registers an app with `--origin https://a.example` and `--email-confirmation-url https://other.example/confirm`
- WHEN the app is created
- THEN the CLI exits non-zero naming the URL and nothing is persisted

#### Scenario: URL origin is listed
- GIVEN `--origin https://a.example`, `--email-confirmation-url https://a.example/confirm` and `--password-reset-url https://a.example/reset`
- WHEN the app is created
- THEN it is accepted

#### Scenario: Update that orphans a URL
- GIVEN an app whose `password_reset_url` is `https://a.example/reset` and whose origins are `https://a.example`
- WHEN the operator updates the origins to `https://b.example` only
- THEN the update is rejected and nothing is persisted

#### Scenario: Update of a URL to an unlisted origin
- GIVEN an app whose only origin is `https://a.example`
- WHEN the operator updates `email_confirmation_url` to `https://b.example/confirm`
- THEN the update is rejected and nothing is persisted

#### Scenario: http only for local development
- GIVEN `NODE_ENV` is not `production`
- WHEN an operator supplies `http://localhost:3000/confirm`
- THEN it is accepted
- AND the same value is rejected when `NODE_ENV=production`

### Requirement: Post-reset redirect URI removed

The `post_reset_redirect_uri` setting MUST NOT exist. The CLI MUST NOT accept it, and no endpoint MUST redirect users after a reset.

#### Scenario: Option gone
- GIVEN an operator passes `--post-reset-redirect-uri`
- WHEN the CLI runs
- THEN it rejects the unknown option

### Requirement: Operator-only management

App creation, update, and deactivation MUST be available only through an operator CLI or seed. The service MUST NOT expose HTTP endpoints for app management in Phase 1.

#### Scenario: No management over HTTP
- GIVEN the running service
- WHEN any client requests an app create/update/delete route
- THEN the service responds 404

### Requirement: Unknown or inactive app

The system MUST reject any request carrying an unknown or deactivated `client_id` with a generic invalid-client error, and MUST NOT redirect.

#### Scenario: Unknown client_id
- GIVEN no app with `client_id=zzz`
- WHEN a request references `zzz`
- THEN the service returns a generic invalid-client error

### Requirement: Origin bound to client (CORS)

CORS MUST apply to the credential endpoints: login, refresh, logout, signup, confirm, resend-confirmation, forgot, reset, change and `/me`. A browser request with an `Origin` header MUST be allowed only when the origin exactly matches (string equality) an `allowed_origins` entry of the app identified by the request's `client_id`, not of any active app. For `/me` and `change`, the app is the one named by the access token's `aud`. A request whose origin is not bound to its app MUST get no CORS allow header and MUST be rejected with the generic invalid-client error (on login this is the generic login failure of `session-auth`; on confirm and reset, whose token names the app, it is the generic invalid-or-expired error; on refresh it is the same `401 invalid_grant` as an invalid token; on logout the response is still `204` but nothing is revoked; on `/me` and `change` it is the generic `401`). A preflight (`OPTIONS`) has no body, so it MAY be answered when the origin belongs to ANY active app; the actual request is still checked against its own `client_id`. A preflight answer MUST be `204` with exactly: `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Methods: GET, POST, OPTIONS`, `Access-Control-Allow-Headers: Content-Type, Authorization` (fixed, not echoed from the request), `Access-Control-Max-Age: 600` and `Vary: Origin`. Every CORS response, preflight or not, MUST carry `Vary: Origin`. Requests without `Origin` (native clients, servers) are not CORS-gated. The service MUST NOT answer with a wildcard origin, MUST NOT send `Access-Control-Allow-Credentials`, and MUST NOT set cookies. Allowed origin lookups MAY be cached up to 30 seconds. CORS is not an authentication control: it only gates browsers.

#### Scenario: Origin bound to its own client
- GIVEN app A allows `https://a.example` and app B allows `https://b.example`
- WHEN a browser at `https://b.example` posts login with `client_id` A
- THEN no `Access-Control-Allow-Origin` is returned
- AND the request is rejected with the generic invalid-client error

#### Scenario: Matching origin
- GIVEN app A allows `https://a.example`
- WHEN a browser at that origin posts login with `client_id` A
- THEN the response carries `Access-Control-Allow-Origin: https://a.example`
- AND no `Access-Control-Allow-Credentials` header

#### Scenario: Preflight
- GIVEN `https://b.example` belongs to an active app
- WHEN it sends `OPTIONS /api/v1/auth/login` with no body
- THEN the response is 204 with its origin allowed
- AND `Access-Control-Allow-Methods` is `GET, POST, OPTIONS`
- AND `Access-Control-Allow-Headers` is `Content-Type, Authorization` even when the request asks for other headers
- AND `Access-Control-Max-Age` is `600` and `Vary` includes `Origin`
- AND no `Access-Control-Allow-Credentials` header is present

#### Scenario: Inactive app origin
- GIVEN app C is inactive and allows `https://c.example`
- WHEN a browser from that origin sends any request
- THEN no CORS allow header is returned

#### Scenario: /me uses the token audience
- GIVEN a token with `aud` A, called from app B's origin
- WHEN `GET /api/v1/me` is sent
- THEN no CORS allow header is returned

### Requirement: Origin and URL validation at registration

The system MUST validate app fields on create and update, and MUST reject invalid input without persisting anything. Each allowed origin MUST be an origin only: scheme `https` (or `http` for `localhost` and `127.0.0.1` outside production), host, and an optional port. Path, query, fragment, userinfo, trailing slash, the literal `null`, and wildcards MUST be rejected. Scheme and host MUST be stored lower-cased (default port dropped), duplicates removed. Generated `client_id` values MUST never start with `-` (format `app_` plus 32 lowercase hex characters).

#### Scenario: Trailing slash origin
- GIVEN an operator registers an app with `--origin https://a.example/`
- WHEN the app is created
- THEN the CLI exits non-zero and nothing is persisted

#### Scenario: Origin is normalized
- GIVEN an operator registers `--origin HTTPS://A.Example`
- WHEN the app is created
- THEN the stored origin is `https://a.example`
