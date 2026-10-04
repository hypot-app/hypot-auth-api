# App Registry Specification

## Purpose

Defines first-class client applications (apps) that the Auth service serves. Every account, token, and email is scoped to exactly one app.

## Requirements

### Requirement: App record

The system MUST store each app with a unique `app_id`, a unique public `client_id`, a display name, a client type (`public` or `confidential`), a list of registered redirect URIs, a list of allowed origins, and email template settings. Confidential apps MUST have a client secret stored hashed. Public apps MUST NOT have a client secret.

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
