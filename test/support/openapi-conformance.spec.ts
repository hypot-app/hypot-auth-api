import { buildOpenApiDocument } from '../../src/openapi/openapi-document';
import { responseSchema, violations } from './openapi-conformance';

const document = buildOpenApiDocument({ version: 'test' });
const schemaOf = (name: string) => ({ $ref: `#/components/schemas/${name}` });

describe('openapi conformance helper', () => {
  it('accepts a token pair and rejects every way it can be wrong', () => {
    const good = { access_token: 'a.b.c', token_type: 'Bearer', expires_in: 3600, refresh_token: 'r' };

    expect(violations(document, schemaOf('TokenPair'), good)).toEqual([]);
    expect(violations(document, schemaOf('TokenPair'), { ...good, expires_in: 60 })).toEqual(['$.expires_in: expected 3600']);
    expect(violations(document, schemaOf('TokenPair'), { ...good, extra: 1 })).toEqual(['$.extra: is not documented']);
    expect(violations(document, schemaOf('TokenPair'), { token_type: 'Bearer', expires_in: 3600, refresh_token: 'r' })).toEqual([
      '$.access_token: is required',
    ]);
    expect(violations(document, schemaOf('TokenPair'), { ...good, refresh_token: 5 })).toEqual(['$.refresh_token: expected a string']);
  });

  it('checks formats, arrays and enums', () => {
    const profile = { id: 'c0a8012e-7c1f-4c1a-9a53-0f0d0a1b2c3d', email: 'a@b.c', email_verified: true, created_at: '2026-01-01T00:00:00.000Z' };

    expect(violations(document, schemaOf('Profile'), profile)).toEqual([]);
    expect(violations(document, schemaOf('Profile'), { ...profile, id: 'nope' })).toEqual(['$.id: not a uuid']);
    expect(violations(document, schemaOf('Profile'), { ...profile, created_at: 'yesterday' })).toEqual(['$.created_at: not an ISO 8601 UTC date-time']);
    expect(violations(document, schemaOf('Jwks'), { keys: [{ kty: 'RSA' }] })).toContain('$.keys[0].n: is required');
    expect(violations(document, schemaOf('Jwks'), { keys: [] })).toEqual([]);
    const loginError = responseSchema(document, 'post', '/api/v1/auth/login', 401)!;
    expect(violations(document, loginError, { error: 'invalid_credentials', message: 'x' })).toEqual([]);
    expect(violations(document, loginError, { error: 'invalid_grant', message: 'x' })).toEqual(['$.error: expected "invalid_credentials"']);
  });

  it('throws for a status the document does not describe', () => {
    expect(() => responseSchema(document, 'post', '/api/v1/auth/login', 429)).toThrow('documents no 429 response');
  });
});
