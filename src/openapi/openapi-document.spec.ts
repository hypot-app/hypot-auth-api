import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpenApiDocument, ERROR_CODES, type OpenApiDocument } from './openapi-document';

const root = join(__dirname, '..', '..');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const document = buildOpenApiDocument({ version });

interface Operation {
  security?: Record<string, unknown>[];
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, { content?: Record<string, { schema: Record<string, unknown> }> }>;
}
const operations = (doc: OpenApiDocument = document): { method: string; path: string; operation: Operation }[] =>
  Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ method, path, operation: operation as unknown as Operation })),
  );

/** The error codes a response schema allows (const or enum on `error`). */
function codesOf(schema: Record<string, unknown>): string[] {
  const error = (schema.properties as Record<string, { const?: string; enum?: string[] }> | undefined)?.error;
  return error?.const !== undefined ? [error.const] : (error?.enum ?? []);
}

describe('OpenAPI document (19.2)', () => {
  it('is OpenAPI 3.1 and describes the 13 routes, each under the right prefix', () => {
    const routes = operations().map(({ method, path }) => `${method.toUpperCase()} ${path}`);

    expect(document.openapi).toBe('3.1.0');
    expect(routes).toHaveLength(13);
    expect(routes.filter((route) => route.includes(' /api/v1/'))).toHaveLength(10);
    expect(routes.filter((route) => !route.includes(' /api/v1/')).sort()).toEqual(['GET /', 'GET /.well-known/jwks.json', 'GET /health']);
  });

  it('gives each of the 9 POST routes a JSON body and the 4 GET routes none', () => {
    const withBody = operations().filter(({ operation }) => operation.requestBody !== undefined);
    expect(withBody.map(({ method, path }) => `${method} ${path}`).sort()).toEqual([
      'post /api/v1/accounts/confirm',
      'post /api/v1/accounts/resend-confirmation',
      'post /api/v1/accounts/signup',
      'post /api/v1/auth/login',
      'post /api/v1/auth/logout',
      'post /api/v1/auth/refresh',
      'post /api/v1/password/change',
      'post /api/v1/password/forgot',
      'post /api/v1/password/reset',
    ]);
    for (const { operation } of withBody) expect(Object.keys(operation.requestBody!.content)).toEqual(['application/json']);
    expect(operations().filter(({ operation }) => operation.requestBody === undefined).map(({ method }) => method)).toEqual(['get', 'get', 'get', 'get']);
  });

  it('declares the request fields of each body', () => {
    const required = (name: string) => (document.components.schemas[name]!.required as string[]).slice().sort();

    expect(required('SignupRequest')).toEqual(['client_id', 'email', 'password']);
    expect(required('EmailRequest')).toEqual(['client_id', 'email']);
    expect(required('ConfirmRequest')).toEqual(['token']);
    expect(required('LoginRequest')).toEqual(['client_id', 'email', 'password']);
    expect(required('RefreshRequest')).toEqual(['client_id', 'refresh_token']);
    expect(required('ResetRequest')).toEqual(['new_password', 'token']);
    expect(required('ChangeRequest')).toEqual(['current_password', 'new_password']);
  });

  it('has the bearer scheme, used by /me and password/change only', () => {
    expect(document.components.securitySchemes.bearerAuth).toEqual(expect.objectContaining({ type: 'http', scheme: 'bearer' }));

    const secured = operations()
      .filter(({ operation }) => (operation.security ?? []).length > 0)
      .map(({ method, path }) => `${method} ${path}`);

    expect(secured.sort()).toEqual(['get /api/v1/me', 'post /api/v1/password/change']);
  });

  it('answers 415 on every POST and 429 only where the contract says so', () => {
    const posts = operations().filter(({ method }) => method === 'post');
    for (const { operation } of posts) expect(Object.keys(operation.responses)).toContain('415');

    const limited = posts.filter(({ operation }) => '429' in operation.responses).map(({ path }) => path);
    expect(limited.sort()).toEqual([
      '/api/v1/accounts/confirm',
      '/api/v1/accounts/resend-confirmation',
      '/api/v1/accounts/signup',
      '/api/v1/auth/refresh',
      '/api/v1/password/forgot',
      '/api/v1/password/reset',
    ]);
  });

  it('resolves every $ref', () => {
    const text = JSON.stringify(document);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/(schemas|headers)\/([A-Za-z]+)"/g)];
    expect(refs.length).toBeGreaterThan(10);
    for (const [, kind, name] of refs) {
      expect((document.components as unknown as Record<string, Record<string, unknown>>)[kind!]![name!]).toBeDefined();
    }
  });

  it('uses only documented error codes, and documents each of them somewhere', () => {
    const documented = new Set(ERROR_CODES.map((row) => row.error));
    const used = new Set<string>();
    for (const { operation } of operations()) {
      for (const response of Object.values(operation.responses)) {
        const schema = response.content?.['application/json']?.schema;
        if (schema !== undefined) codesOf(schema).forEach((code) => used.add(code));
      }
    }

    expect([...used].filter((code) => !documented.has(code))).toEqual([]);
    expect([...documented].filter((code) => !used.has(code))).toEqual([]);
  });

  it('puts each error code on the status the table gives it', () => {
    const statusOf = new Map(ERROR_CODES.map((row) => [row.error, row.status]));
    for (const { operation } of operations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const schema = response.content?.['application/json']?.schema;
        for (const code of schema === undefined ? [] : codesOf(schema)) expect([code, statusOf.get(code)]).toEqual([code, Number(status)]);
      }
    }
  });

  it('matches the error table of docs/api-contract.md', () => {
    const contract = readFileSync(join(root, 'docs', 'api-contract.md'), 'utf8');
    const table = contract.split('### Error codes')[1]!.split('Texts: the fixed')[0]!;
    const rows = [...table.matchAll(/^\| (\d{3}) \| ((?:`[a-z_]+`(?:, )?)+) \|/gm)].flatMap(([, status, codes]) =>
      [...codes!.matchAll(/`([a-z_]+)`/g)].map(([, code]) => `${status} ${code}`),
    );

    expect(rows.sort()).toEqual(ERROR_CODES.map((row) => `${row.status} ${row.error}`).sort());
  });

  it('is the content of the committed openapi.json (run npm run openapi:generate after changing it)', () => {
    const committed = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8')) as unknown;

    expect(committed).toEqual(JSON.parse(JSON.stringify(document)));
  });
});
