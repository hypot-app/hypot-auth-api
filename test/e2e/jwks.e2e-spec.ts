import type { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import request from 'supertest';
import { ACCESS_TOKEN_ISSUER, type AccessTokenIssuer } from '../../src/token-lifecycle/domain/access-token';
import { generateKeySet } from '../../src/token-lifecycle/infrastructure/signing-key-generator';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('GET /.well-known/jwks.json (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  const current = generateKeySet(); // active + next
  const previous = generateKeySet({ next: false });
  const keySet = { ...current, retired: [previous.active] };

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url, config: { signingKeysJson: JSON.stringify(keySet) } });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it('publishes active, next and retired public keys with a 5 minute cache and no private material', async () => {
    const response = await request(app.getHttpServer()).get('/.well-known/jwks.json').expect(200);

    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.body.keys.map((jwk: { kid: string }) => jwk.kid)).toEqual([
      current.active.kid,
      current.next?.kid,
      previous.active.kid,
    ]);
    for (const jwk of response.body.keys) {
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
    }
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(response.text).not.toContain(`"${field}":`);
    }
  });

  it('lets a consumer verify an issued token offline with the JWKS fetched over HTTP, for its own audience only', async () => {
    const issuer = app.get<AccessTokenIssuer>(ACCESS_TOKEN_ISSUER);
    const { token } = await issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

    const response = await request(app.getHttpServer()).get('/.well-known/jwks.json');
    const consumerKeys = createLocalJWKSet(response.body as JSONWebKeySet);
    const options = { algorithms: ['RS256'], issuer: 'http://localhost:3000' };

    const { payload, protectedHeader } = await jwtVerify(token, consumerKeys, { ...options, audience: 'app_a' });
    expect(payload.sub).toBe('account-1');
    expect(protectedHeader.kid).toBe(keySet.active.kid);
    await expect(jwtVerify(token, consumerKeys, { ...options, audience: 'app_b' })).rejects.toThrow('"aud"');
  });
});
