/**
 * The OpenAPI 3.1 description of the public API (19.2). It is written by hand, in code, because the service has no
 * reflection layer over its controllers; test/e2e/openapi-contract.e2e-spec.ts keeps it honest by comparing its
 * paths with the routes Express registers and by sending real requests for the documented outcomes.
 * `npm run openapi:generate` writes it to `openapi.json` (a build artifact, never a runtime route).
 */

export type JsonSchema = Record<string, unknown>;
export interface OpenApiDocument {
  openapi: '3.1.0';
  info: Record<string, unknown>;
  servers: Record<string, unknown>[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, unknown>;
    headers: Record<string, unknown>;
  };
  'x-error-codes': ErrorCodeRow[];
}

export interface ErrorCodeRow {
  status: number;
  error: string;
  where: string;
}

/** The error table of docs/api-contract.md. A test keeps the two in step. */
export const ERROR_CODES: readonly ErrorCodeRow[] = [
  { status: 415, error: 'unsupported_media_type', where: 'Every POST under /api/v1: Content-Type is not application/json, or is missing.' },
  { status: 400, error: 'invalid_request', where: 'Any body endpoint: malformed body.' },
  { status: 400, error: 'invalid_email', where: 'Signup, resend, forgot.' },
  { status: 400, error: 'invalid_password', where: 'Signup, reset, change.' },
  { status: 400, error: 'invalid_client', where: 'Signup, resend, forgot, refresh: unknown or inactive client_id, or (signup, resend, forgot) origin not bound to it.' },
  { status: 400, error: 'unconfigured_client', where: 'Signup, resend, forgot: the app has no email URLs.' },
  { status: 400, error: 'invalid_or_expired_link', where: 'Confirm, reset: bad token, or a known token from the wrong origin.' },
  { status: 400, error: 'invalid_current_password', where: 'Change: wrong current password (also while blocked).' },
  { status: 401, error: 'invalid_credentials', where: 'Login: one identical failure for every cause.' },
  { status: 401, error: 'invalid_grant', where: 'Refresh: the session or token is gone, or the origin is not bound.' },
  { status: 401, error: 'invalid_token', where: '/me, change: missing, expired or bad access token (header WWW-Authenticate: Bearer).' },
  { status: 429, error: 'rate_limited', where: 'Signup, resend, forgot, reset, confirm, refresh (never login). Has Retry-After.' },
  { status: 503, error: 'temporarily_unavailable', where: 'Endpoints that consult the limiter when its store is down.' },
];

const JSON_TYPE = 'application/json';
const CLIENT_ID_PATTERN = '^app_[0-9a-f]{32}$';

const ref = (name: string): { $ref: string } => ({ $ref: `#/components/schemas/${name}` });
const headerRef = (name: string): { $ref: string } => ({ $ref: `#/components/headers/${name}` });
const jsonContent = (schema: JsonSchema): Record<string, unknown> => ({ [JSON_TYPE]: { schema } });

/** An error body whose `error` is one of `codes`. */
function errorBody(...codes: string[]): JsonSchema {
  return {
    type: 'object',
    required: ['error', 'message'],
    properties: { error: codes.length === 1 ? { const: codes[0] } : { enum: codes }, message: { type: 'string' } },
    additionalProperties: false,
  };
}

const NO_STORE = { 'Cache-Control': headerRef('NoStore'), Pragma: headerRef('NoCachePragma') };

function failure(description: string, headers: Record<string, unknown> = {}) {
  return (...codes: string[]) => ({ description, headers, content: jsonContent(errorBody(...codes)) });
}

const UNSUPPORTED = {
  description: 'The Content-Type is not application/json, or is missing. No allow header, no limit counted.',
  content: jsonContent(errorBody('unsupported_media_type')),
};
const RATE_LIMITED = {
  description: 'An IP-keyed limit was hit. The decision never depends on account or token state.',
  headers: { 'Retry-After': headerRef('RetryAfter') },
  content: jsonContent(errorBody('rate_limited')),
};
const UNAVAILABLE = {
  description: 'The limiter store is down. The request was not processed.',
  content: jsonContent(errorBody('temporarily_unavailable')),
};

const CORS_NOTE =
  'A request with an Origin header is allowed only when the origin is bound to the app the request identifies; the ' +
  'allow header is granted fail-closed. See docs/api-contract.md, section CORS.';

interface PostOptions {
  tag: string;
  summary: string;
  description: string;
  request: string;
  responses: Record<string, unknown>;
  security?: boolean;
}

function post({ tag, summary, description, request, responses, security = false }: PostOptions) {
  return {
    post: {
      tags: [tag],
      summary,
      description: `${description}\n\n${CORS_NOTE}`,
      requestBody: { required: true, content: jsonContent(ref(request)) },
      security: security ? [{ bearerAuth: [] }] : [],
      responses: { ...responses, '415': UNSUPPORTED },
    },
  };
}

const clientIdProperty = { type: 'string', maxLength: 128, pattern: CLIENT_ID_PATTERN, description: 'Public client id of the app.' };
const stringProperty = (description: string): JsonSchema => ({ type: 'string', description });

function requestSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', required: Object.keys(properties), properties, additionalProperties: true };
}

const MESSAGE_ONLY = (example: string): JsonSchema => ({
  type: 'object',
  required: ['message'],
  properties: { message: { type: 'string', examples: [example] } },
  additionalProperties: false,
});

const messageResponse = (description: string, schema: string, headers: Record<string, unknown> = {}) => ({
  description,
  headers,
  content: jsonContent(ref(schema)),
});

export function buildOpenApiDocument(options: { version: string }): OpenApiDocument {
  const tokenPairResponse = {
    description: 'A new access token and refresh token. No Set-Cookie.',
    headers: NO_STORE,
    content: jsonContent(ref('TokenPair')),
  };
  const authError = failure('Error', NO_STORE);

  return {
    openapi: '3.1.0',
    info: {
      title: 'hypot Auth API',
      version: options.version,
      description:
        'API-only centralized authentication for first-party apps. JSON in and out, no cookies, no redirects, no HTML. ' +
        'Business routes live under /api/v1; JWKS, / and /health are at the root. Prose contract: docs/api-contract.md.',
    },
    servers: [
      {
        url: '{authBaseUrl}',
        description: 'The value of AUTH_PUBLIC_BASE_URL, which is also the `iss` of every access token.',
        variables: { authBaseUrl: { default: 'https://auth.example' } },
      },
    ],
    tags: [
      { name: 'Platform', description: 'Operational routes and token verification keys.' },
      { name: 'Accounts', description: 'Signup, email confirmation and the profile.' },
      { name: 'Session auth', description: 'Login, refresh and logout.' },
      { name: 'Password management', description: 'Forgot, reset and change.' },
    ],
    paths: {
      '/': {
        get: {
          tags: ['Platform'],
          summary: 'Welcome',
          description: 'Operational only. No CORS, no limits.',
          security: [],
          responses: { '200': messageResponse('Welcome message.', 'Welcome') },
        },
      },
      '/health': {
        get: {
          tags: ['Platform'],
          summary: 'Health',
          description: 'Pings the database. No CORS, no limits.',
          security: [],
          responses: {
            '200': { description: 'The database answers.', content: jsonContent(ref('HealthUp')) },
            '503': { description: 'The database is down.', content: jsonContent(ref('HealthDown')) },
          },
        },
      },
      '/.well-known/jwks.json': {
        get: {
          tags: ['Platform'],
          summary: 'JSON Web Key Set',
          description:
            'Public RSA keys that verify access tokens (RS256). During rotation current and previous keys are published. ' +
            'The URL is `${iss}/.well-known/jwks.json`. Consumed server to server: no CORS.',
          security: [],
          responses: {
            '200': {
              description: 'The key set.',
              headers: { 'Cache-Control': { description: 'public, max-age=300', schema: { type: 'string' } } },
              content: jsonContent(ref('Jwks')),
            },
          },
        },
      },
      '/api/v1/accounts/signup': post({
        tag: 'Accounts',
        summary: 'Create an unconfirmed account',
        description:
          'Always answers the same 202 for a new and an existing address. A new account is unconfirmed and gets a ' +
          'confirmation email (24 h link); an existing address gets an "account exists" notice. No tokens are issued.',
        request: 'SignupRequest',
        responses: {
          '202': messageResponse('Accepted. Fixed text, identical for a new and an existing address.', 'SignupAccepted'),
          '400': failure('Rejected request.')(
            'invalid_request',
            'invalid_email',
            'invalid_password',
            'invalid_client',
            'unconfigured_client',
          ),
          '429': RATE_LIMITED,
          '503': UNAVAILABLE,
        },
      }),
      '/api/v1/accounts/confirm': post({
        tag: 'Accounts',
        summary: 'Confirm an email address',
        description:
          'Takes the token from the `#token` fragment of the email link. The token identifies the app. There is no GET ' +
          'form: a link scanner cannot confirm an account.',
        request: 'ConfirmRequest',
        responses: {
          '200': messageResponse('Confirmed. The token is used and a welcome email is sent.', 'Confirmed'),
          '400': failure('Malformed body, or one identical answer for a bad, used, expired or foreign token.')(
            'invalid_request',
            'invalid_or_expired_link',
          ),
          '429': RATE_LIMITED,
          '503': UNAVAILABLE,
        },
      }),
      '/api/v1/accounts/resend-confirmation': post({
        tag: 'Accounts',
        summary: 'Send a new confirmation email',
        description: 'Identical 202 for unknown, unconfirmed and confirmed accounts.',
        request: 'EmailRequest',
        responses: {
          '202': messageResponse('Accepted. Fixed text.', 'ResendAccepted'),
          '400': failure('Rejected request.')('invalid_request', 'invalid_email', 'invalid_client', 'unconfigured_client'),
          '429': RATE_LIMITED,
          '503': UNAVAILABLE,
        },
      }),
      '/api/v1/me': {
        get: {
          tags: ['Accounts'],
          summary: 'Profile of the account behind the access token',
          description: `${CORS_NOTE} Exactly four keys. Auth stores no name or avatar: keep profile data in your app, keyed by \`id\`.`,
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'The profile.', headers: NO_STORE, content: jsonContent(ref('Profile')) },
            '401': {
              description:
                'One identical answer for no token, an expired or bad token, an unknown or inactive audience, an unknown account, or an origin not bound to the audience app. Never an allow header.',
              headers: { 'WWW-Authenticate': headerRef('WwwAuthenticate'), ...NO_STORE },
              content: jsonContent(errorBody('invalid_token')),
            },
          },
        },
      },
      '/api/v1/auth/login': post({
        tag: 'Session auth',
        summary: 'Log in with email and password',
        description:
          'One identical 401 for every failure: unknown email, wrong password, unconfirmed or locked account, blocked ' +
          'pair, IP over its limit, unknown client, origin not bound. Never 429.',
        request: 'LoginRequest',
        responses: {
          '200': tokenPairResponse,
          '400': authError('invalid_request'),
          '401': authError('invalid_credentials'),
          '503': { ...UNAVAILABLE, headers: NO_STORE },
        },
      }),
      '/api/v1/auth/refresh': post({
        tag: 'Session auth',
        summary: 'Rotate a refresh token',
        description:
          'Consumes the presented refresh token and issues a new pair in the same session. A reused token revokes the ' +
          'session, except for one retry inside the grace window (REFRESH_REUSE_GRACE_SECONDS, default 10 s, same IP).',
        request: 'RefreshRequest',
        responses: {
          '200': tokenPairResponse,
          '400': authError('invalid_request', 'invalid_client'),
          '401': authError('invalid_grant'),
          '429': { ...RATE_LIMITED, headers: { ...NO_STORE, ...RATE_LIMITED.headers } },
          '503': { ...UNAVAILABLE, headers: NO_STORE },
        },
      }),
      '/api/v1/auth/logout': post({
        tag: 'Session auth',
        summary: 'Revoke the session of a refresh token',
        description:
          'Idempotent and no oracle: 204 for an active, used, expired, unknown or other-app token. The session is revoked ' +
          'only when the token belongs to client_id and any Origin is bound to that app.',
        request: 'RefreshRequest',
        responses: {
          '204': { description: 'No content.', headers: NO_STORE },
          '400': authError('invalid_request'),
        },
      }),
      '/api/v1/password/forgot': post({
        tag: 'Password management',
        summary: 'Request a password reset email',
        description:
          'Always the same 202. A confirmed account gets a reset email (1 h link); an unconfirmed account gets a ' +
          'confirmation email instead; an unknown address gets nothing.',
        request: 'EmailRequest',
        responses: {
          '202': messageResponse('Accepted. Fixed text.', 'ForgotAccepted'),
          '400': failure('Rejected request.')('invalid_request', 'invalid_email', 'invalid_client', 'unconfigured_client'),
          '429': RATE_LIMITED,
          '503': UNAVAILABLE,
        },
      }),
      '/api/v1/password/reset': post({
        tag: 'Password management',
        summary: 'Set a new password with a reset token',
        description: 'Replaces the password, uses the token and revokes every session of the account.',
        request: 'ResetRequest',
        responses: {
          '204': { description: 'No content. Password replaced, all sessions revoked.' },
          '400': failure('Rejected request. A weak password keeps the token usable.')(
            'invalid_request',
            'invalid_password',
            'invalid_or_expired_link',
          ),
          '429': RATE_LIMITED,
          '503': UNAVAILABLE,
        },
      }),
      '/api/v1/password/change': post({
        tag: 'Password management',
        summary: 'Change the password of the signed-in account',
        description:
          'Replaces the password, revokes every session including the caller\'s and queues a notice email. A wrong ' +
          'current password is 400, never 401. It counts as a failed login for both lockout counters.',
        request: 'ChangeRequest',
        security: true,
        responses: {
          '204': { description: 'No content. Password replaced, all sessions revoked.' },
          '400': failure('Rejected request.')('invalid_request', 'invalid_password', 'invalid_current_password'),
          '401': {
            description: 'Missing or invalid access token.',
            headers: { 'WWW-Authenticate': headerRef('WwwAuthenticate') },
            content: jsonContent(errorBody('invalid_token')),
          },
          '503': UNAVAILABLE,
        },
      }),
    },
    components: {
      schemas: {
        Welcome: MESSAGE_ONLY('Welcome to the API'),
        HealthUp: {
          type: 'object',
          required: ['status', 'db'],
          properties: { status: { const: 'ok' }, db: { const: 'up' } },
          additionalProperties: false,
        },
        HealthDown: {
          type: 'object',
          required: ['status', 'db'],
          properties: { status: { const: 'error' }, db: { const: 'down' } },
          additionalProperties: false,
        },
        Jwks: {
          type: 'object',
          required: ['keys'],
          properties: {
            keys: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kty', 'n', 'e', 'kid', 'alg', 'use'],
                properties: {
                  kty: { const: 'RSA' },
                  n: { type: 'string' },
                  e: { type: 'string' },
                  kid: { type: 'string' },
                  alg: { const: 'RS256' },
                  use: { const: 'sig' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        SignupRequest: requestSchema({
          client_id: clientIdProperty,
          email: stringProperty('Trimmed and compared case-insensitively.'),
          password: stringProperty('Minimum 8 characters, maximum 72 UTF-8 bytes, no NUL.'),
        }),
        EmailRequest: requestSchema({
          client_id: clientIdProperty,
          email: stringProperty('Trimmed and compared case-insensitively.'),
        }),
        ConfirmRequest: requestSchema({ token: stringProperty('The value of `#token` in the email link.') }),
        LoginRequest: requestSchema({
          client_id: clientIdProperty,
          email: stringProperty('Email address.'),
          password: stringProperty('Password.'),
        }),
        RefreshRequest: requestSchema({
          client_id: clientIdProperty,
          refresh_token: stringProperty('The opaque refresh token from login or the last refresh.'),
        }),
        ResetRequest: requestSchema({
          token: stringProperty('The value of `#token` in the reset email link.'),
          new_password: stringProperty('Minimum 8 characters, maximum 72 UTF-8 bytes, no NUL.'),
        }),
        ChangeRequest: requestSchema({
          current_password: stringProperty('The current password.'),
          new_password: stringProperty('Minimum 8 characters, maximum 72 UTF-8 bytes, no NUL.'),
        }),
        SignupAccepted: MESSAGE_ONLY('If this address can be registered, a confirmation email is on its way.'),
        ResendAccepted: MESSAGE_ONLY('If an unconfirmed account exists for this address, a new confirmation email is on its way.'),
        ForgotAccepted: MESSAGE_ONLY('If an account exists for this address, an email is on its way.'),
        Confirmed: MESSAGE_ONLY('Your email address has been confirmed.'),
        TokenPair: {
          type: 'object',
          required: ['access_token', 'token_type', 'expires_in', 'refresh_token'],
          properties: {
            access_token: { type: 'string', description: 'RS256 JWT, typ at+jwt, one hour.' },
            token_type: { const: 'Bearer' },
            expires_in: { const: 3600, description: 'Seconds until the access token expires.' },
            refresh_token: { type: 'string', description: 'Opaque, rotating.' },
          },
          additionalProperties: false,
        },
        Profile: {
          type: 'object',
          required: ['id', 'email', 'email_verified', 'created_at'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'The account id; equals the token `sub`.' },
            email: { type: 'string' },
            email_verified: { type: 'boolean' },
            created_at: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        Error: errorBody(...ERROR_CODES.map((row) => row.error)),
      },
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from login or refresh.' },
      },
      headers: {
        NoStore: { description: 'no-store', schema: { type: 'string', const: 'no-store' } },
        NoCachePragma: { description: 'no-cache', schema: { type: 'string', const: 'no-cache' } },
        RetryAfter: { description: 'Seconds to wait, an integer of at least 1.', schema: { type: 'integer', minimum: 1 } },
        WwwAuthenticate: { description: 'Bearer', schema: { type: 'string', const: 'Bearer' } },
      },
    },
    'x-error-codes': [...ERROR_CODES],
  };
}
