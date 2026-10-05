import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

  it('lets a consumer verify a signature offline with the published key and its kid', async () => {
    const payload = Buffer.from('signed-by-the-active-key');
    const signature = sign('sha256', payload, createPrivateKey({ key: keySet.active as never, format: 'jwk' }));

    const response = await request(app.getHttpServer()).get('/.well-known/jwks.json');
    const published = response.body.keys.find((jwk: { kid: string }) => jwk.kid === keySet.active.kid);

    expect(verify('sha256', payload, createPublicKey({ key: published, format: 'jwk' }), signature)).toBe(true);
  });
});
