# App Registry Specification

## Purpose

Defines first-class client applications (apps) that the Auth service serves. Every account, token, and email is scoped to exactly one app.

## Requirements

### Requirement: App record

The system MUST store each app with a unique `app_id`, a unique public `client_id`, a display name, a client type (`public` or `confidential`), a list of registered redirect URIs, a list of allowed origins, an optional post-reset redirect URI, and email template settings. Confidential apps MUST have a client secret stored hashed. Public apps MUST NOT have a client secret.

#### Scenario: Register a public app
- GIVEN an operator runs the registration CLI (or seed) with a name, redirect URIs, and origins, and no secret
- WHEN the app is created
- THEN the app has a generated `client_id` and type `public`
- AND no client secret exists for it

#### Scenario: Register a confidential app
- GIVEN an operator registers an app with type `confidential`
- WHEN the app is created
- THEN a client secret is shown once to the operator
- AND only its hash is persisted

### Requirement: Post-reset redirect URI

The system MUST support an optional per-app `post_reset_redirect_uri` (nullable): the fixed URL where Auth sends the user after a successful password reset. When set, it MUST be an absolute URL with the `https` scheme. The `http` scheme MUST be accepted only for the hosts `localhost` and `127.0.0.1`, and only when `NODE_ENV` is not `production`. The value MUST be validated when an app is registered and when it is updated through the CLI, and an invalid value MUST be rejected with no change persisted. The value MUST contain no credentials (userinfo) and no fragment. The value is distinct from `redirect_uris` (the OAuth authorization list) and MUST NOT be used for authorization requests.

#### Scenario: Register with a valid https URL
- GIVEN an operator registers an app with `--post-reset-redirect-uri https://a.example/login`
- WHEN the app is created
- THEN `post_reset_redirect_uri` is stored as given

#### Scenario: Register without the option
- GIVEN an operator registers an app without the option
- WHEN the app is created
- THEN `post_reset_redirect_uri` is null

#### Scenario: Update and clear
- GIVEN an app with a stored `post_reset_redirect_uri`
- WHEN the operator updates it with a valid new URL, or clears it
- THEN the new value (or null) is persisted

#### Scenario: Invalid URL rejected
- GIVEN an operator supplies a relative URL, a `javascript:` or `ftp:` URL, a URL with userinfo or a fragment, or `http://a.example/login`
- WHEN the app is registered or updated
- THEN the CLI rejects the value with a validation error
- AND no change is persisted

#### Scenario: http allowed only for local development
- GIVEN `NODE_ENV` is not `production`
- WHEN an operator supplies `http://localhost:3000/login` or `http://127.0.0.1:3000/login`
- THEN the value is accepted
- AND the same value is rejected when `NODE_ENV=production`

### Requirement: Operator-only management

App creation, update, and deactivation MUST be available only through an operator CLI or seed. The service MUST NOT expose HTTP endpoints for app management in Phase 1. (Assumption: admin API/panel is Phase 3.)

#### Scenario: No management over HTTP
- GIVEN the running service
- WHEN any client requests an app create/update/delete route
- THEN the service responds 404

### Requirement: Redirect URI validation

The system MUST accept an authorization request only when its `redirect_uri` exactly matches (string equality) one of the registered URIs of that app. Wildcards MUST NOT be supported.

#### Scenario: Unregistered redirect URI
- GIVEN app A registers `https://a.example/cb`
- WHEN a request uses `redirect_uri=https://evil.example/cb`
- THEN the request is rejected
- AND the user is NOT redirected to the supplied URI

### Requirement: Unknown or inactive app

The system MUST reject any request carrying an unknown or deactivated `client_id`, without redirecting.

#### Scenario: Unknown client_id
- GIVEN no app with `client_id=zzz`
- WHEN a request references `zzz`
- THEN the service returns a generic invalid-client error

### Requirement: Allowed origins

The system MUST apply CORS only for origins registered on the app identified by the request's `client_id`.

#### Scenario: Origin not registered
- GIVEN app A allows `https://a.example`
- WHEN a browser request for app A comes from `https://other.example`
- THEN no CORS allow header is returned
