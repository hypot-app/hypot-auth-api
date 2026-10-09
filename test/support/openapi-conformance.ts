import type request from 'supertest';
import type { JsonSchema, OpenApiDocument } from '../../src/openapi/openapi-document';

type Json = unknown;

function resolve(document: OpenApiDocument, schema: JsonSchema): JsonSchema {
  const target = schema.$ref;
  if (typeof target !== 'string') return schema;
  const name = target.replace('#/components/schemas/', '');
  const found = document.components.schemas[name];
  if (found === undefined) throw new Error(`unresolved $ref ${target}`);
  return found;
}

/** The schema of a documented JSON response, or undefined when the document gives that status no body. */
export function responseSchema(document: OpenApiDocument, method: string, path: string, status: number): JsonSchema | undefined {
  const operation = document.paths[path]?.[method.toLowerCase()] as
    | { responses?: Record<string, { content?: Record<string, { schema: JsonSchema }> }> }
    | undefined;
  const response = operation?.responses?.[String(status)];
  if (response === undefined) throw new Error(`${method} ${path} documents no ${status} response`);
  return response.content?.['application/json']?.schema;
}

/**
 * Checks a value against the subset of JSON Schema the document uses (type, const, enum, required, properties,
 * additionalProperties: false, items, format date-time and uuid, pattern). Returns the violations; empty means it conforms.
 */
export function violations(document: OpenApiDocument, schema: JsonSchema, value: Json, at = '$'): string[] {
  const resolved = resolve(document, schema);
  if ('const' in resolved && value !== resolved.const) return [`${at}: expected ${JSON.stringify(resolved.const)}`];
  if (Array.isArray(resolved.enum) && !resolved.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not in the enum`];

  switch (resolved.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${at}: expected a string`];
      if (typeof resolved.pattern === 'string' && !new RegExp(resolved.pattern).test(value)) return [`${at}: does not match the pattern`];
      if (resolved.format === 'date-time' && (Number.isNaN(Date.parse(value)) || !/Z$/.test(value))) return [`${at}: not an ISO 8601 UTC date-time`];
      if (resolved.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return [`${at}: not a uuid`];
      return [];
    }
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at}: expected an integer`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: expected a boolean`];
    case 'array': {
      if (!Array.isArray(value)) return [`${at}: expected an array`];
      const items = resolved.items as JsonSchema;
      return value.flatMap((item, index) => violations(document, items, item, `${at}[${index}]`));
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${at}: expected an object`];
      const record = value as Record<string, Json>;
      const properties = (resolved.properties ?? {}) as Record<string, JsonSchema>;
      const problems: string[] = [];
      for (const key of (resolved.required ?? []) as string[]) {
        if (!(key in record)) problems.push(`${at}.${key}: is required`);
      }
      if (resolved.additionalProperties === false) {
        for (const key of Object.keys(record)) if (!(key in properties)) problems.push(`${at}.${key}: is not documented`);
      }
      for (const [key, child] of Object.entries(properties)) {
        if (key in record) problems.push(...violations(document, child, record[key], `${at}.${key}`));
      }
      return problems;
    }
    default:
      return [];
  }
}

interface DocumentedResponse {
  headers?: Record<string, { $ref?: string }>;
  content?: Record<string, { schema: JsonSchema }>;
}

/**
 * Asserts that a real answer is one the document describes: the status is listed for the operation, a JSON body
 * conforms to its schema (and a bodiless status has no body), and every header the document names with a fixed
 * value (Cache-Control, Pragma, WWW-Authenticate) or as Retry-After is present.
 */
export function expectDocumented(document: OpenApiDocument, response: request.Response, method: string, path: string): void {
  const operation = document.paths[path]?.[method.toLowerCase()] as { responses: Record<string, DocumentedResponse> } | undefined;
  if (operation === undefined) throw new Error(`${method} ${path} is not documented`);
  const documented = operation.responses[String(response.status)];
  if (documented === undefined) {
    throw new Error(`${method} ${path} answered ${response.status}, which the document does not list (${response.text})`);
  }
  const schema = documented.content?.['application/json']?.schema;
  if (schema === undefined) {
    if (response.text !== '') throw new Error(`${method} ${path} ${response.status} documents no body but answered ${response.text}`);
  } else {
    const problems = violations(document, schema, response.body);
    if (problems.length > 0) throw new Error(`${method} ${path} ${response.status} body: ${problems.join('; ')} in ${response.text}`);
  }
  const headerNames: Record<string, string> = { NoStore: 'cache-control', NoCachePragma: 'pragma', RetryAfter: 'retry-after', WwwAuthenticate: 'www-authenticate' };
  for (const [name, header] of Object.entries(documented.headers ?? {})) {
    const key = header.$ref?.replace('#/components/headers/', '');
    const actual = response.headers[(key !== undefined ? headerNames[key] : undefined) ?? name.toLowerCase()];
    if (actual === undefined) throw new Error(`${method} ${path} ${response.status} is missing the documented header ${name}`);
    const fixed = key === undefined ? undefined : (document.components.headers[key] as { schema: { const?: string; type: string } }).schema;
    if (fixed?.const !== undefined && actual !== fixed.const) throw new Error(`${name} is ${actual}, the document says ${fixed.const}`);
    if (key === 'RetryAfter' && !/^[1-9]\d*$/.test(actual)) throw new Error(`Retry-After ${actual} is not an integer of at least 1`);
  }
}
