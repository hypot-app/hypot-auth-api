import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import type { App } from '../../src/app-registry/domain/app';
import { createTestApp } from '../support/create-test-app';
import { addTestUser, fingerprint, registerTestApp } from '../support/e2e-fixtures';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const EMAIL_IP_LIMIT = 8;
const FORGOT_TEXT = JSON.stringify({ message: 'If an account exists for this address, an email is on its way.' });
const PASSWORD = 'correct horse';

describe('POST /api/v1/password/forgot (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;
  let passwordHash: string;

  const server = () => app.getHttpServer();
  const forgot = (overrides: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/password/forgot')
      .send({ client_id: shop.clientId, email: 'ana@example.com', ...overrides });
  const emails = (): Promise<{ to_address: string; template: string; payload: { token?: string } }[]> =>
    db.dataSource.query(`SELECT to_address, template, payload FROM email_outbox ORDER BY created_at, id`);
  const templatesFor = async (to: string): Promise<string[]> =>
    (await emails()).filter((email) => email.to_address === to).map((email) => email.template);
  const tokenPurposes = async (): Promise<string[]> =>
    (await db.dataSource.query(`SELECT purpose FROM one_time_tokens`)).map((row: { purpose: string }) => row.purpose);
  const latestToken = async (template: string): Promise<string> => {
    const token = (await emails()).filter((email) => email.template === template).at(-1)?.payload.token;
    if (token === undefined) throw new Error(`no ${template} email was queued`);
    return token;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      passwordHasher: new LowCostPasswordHasher(),
      abusePolicies: resolvePolicies({ email_ip: { limit: EMAIL_IP_LIMIT, windowSeconds: 3600 } }),
    });
    passwordHash = await new LowCostPasswordHasher().hash(PASSWORD);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    shop = await registerTestApp(app, 'Shop', SHOP_ORIGIN);
    blog = await registerTestApp(app, 'Blog', BLOG_ORIGIN);
  });

  it('answers a confirmed, an unconfirmed, an unknown and an other-app-only address byte for byte alike', async () => {
    await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash });
    await addTestUser(app, { appId: shop.id, email: 'unconfirmed@example.com', passwordHash, confirmed: false });
    await addTestUser(app, { appId: blog.id, email: 'blogger@example.com', passwordHash });

    const confirmed = await forgot({ email: 'confirmed@example.com' });
    const unconfirmed = await forgot({ email: 'unconfirmed@example.com' });
    const unknown = await forgot({ email: 'nobody@example.com' });
    const otherApp = await forgot({ email: 'blogger@example.com' });

    for (const response of [confirmed, unconfirmed, unknown, otherApp]) {
      expect(response.status).toBe(202);
      expect(response.text).toBe(FORGOT_TEXT);
    }
    expect(fingerprint(unconfirmed)).toEqual(fingerprint(confirmed));
    expect(fingerprint(unknown)).toEqual(fingerprint(confirmed));
    expect(fingerprint(otherApp)).toEqual(fingerprint(confirmed));
  });

  it('queues a reset for a confirmed account and a confirmation (never a reset) for an unconfirmed one', async () => {
    await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash });
    await addTestUser(app, { appId: shop.id, email: 'unconfirmed@example.com', passwordHash, confirmed: false });
    await addTestUser(app, { appId: blog.id, email: 'blogger@example.com', passwordHash });

    await forgot({ email: 'confirmed@example.com' });
    expect(await tokenPurposes()).toEqual(['password_reset']);
    await forgot({ email: 'unconfirmed@example.com' });
    await forgot({ email: 'nobody@example.com' });
    await forgot({ email: 'blogger@example.com' });

    expect(await templatesFor('confirmed@example.com')).toEqual(['password-reset']);
    expect(await templatesFor('unconfirmed@example.com')).toEqual(['confirmation']);
    expect(await templatesFor('nobody@example.com')).toEqual([]);
    expect(await templatesFor('blogger@example.com')).toEqual([]);
    expect((await tokenPurposes()).sort()).toEqual(['email_verification', 'password_reset']);
  });

  it('sends the unconfirmed account a confirmation that confirms it through POST /accounts/confirm', async () => {
    await addTestUser(app, { appId: shop.id, email: 'unconfirmed@example.com', passwordHash, confirmed: false });
    await forgot({ email: 'unconfirmed@example.com' });

    const confirm = await request(server())
      .post('/api/v1/accounts/confirm')
      .send({ token: await latestToken('confirmation') });

    expect(confirm.status).toBe(200);
    const [row] = await db.dataSource.query(`SELECT email_verified_at FROM users WHERE email = 'unconfirmed@example.com'`);
    expect(row.email_verified_at).not.toBeNull();
  });

  it('has no GET route', async () => {
    expect((await request(server()).get('/api/v1/password/forgot')).status).toBe(404);
  });

  it('still answers 202 when the mail provider is down, because the email is only queued', async () => {
    await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash });
    // The outbox worker is not started in tests, so nothing reaches a provider: a delivery failure can
    // never change this answer. The row stays pending for the worker to retry.
    const response = await forgot({ email: 'confirmed@example.com' });

    expect(response.status).toBe(202);
    const [row] = await db.dataSource.query(`SELECT status FROM email_outbox`);
    expect(row.status).toBe('pending');
  });

  it('counts the confirmation for an unconfirmed account toward the cap: the 4th mail in an hour is suppressed', async () => {
    const accounts = (path: string, body: Record<string, unknown>) =>
      request(server()).post(`/api/v1/accounts/${path}`).send({ client_id: shop.clientId, email: 'ana@example.com', ...body });
    await accounts('signup', { password: PASSWORD });
    await accounts('resend-confirmation', {});
    await forgot();
    const capped = await forgot();

    expect(capped.status).toBe(202);
    expect(capped.text).toBe(FORGOT_TEXT);
    expect(await templatesFor('ana@example.com')).toEqual(['confirmation', 'confirmation', 'confirmation']);
  });

  it('does not let forgot for an unknown address use the cap: a later signup still gets its confirmation', async () => {
    for (let i = 0; i < 4; i += 1) await forgot({ email: 'ghost@example.com' });

    await request(server())
      .post('/api/v1/accounts/signup')
      .send({ client_id: shop.clientId, email: 'ghost@example.com', password: PASSWORD });

    expect(await templatesFor('ghost@example.com')).toEqual(['confirmation']);
  });

  it('limits per client and IP with 429 and an integer Retry-After, identical for known and unknown addresses', async () => {
    await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash });
    for (let i = 0; i < EMAIL_IP_LIMIT; i += 1) {
      await forgot({ email: i % 2 === 0 ? 'confirmed@example.com' : 'nobody@example.com' });
    }

    const known = await forgot({ email: 'confirmed@example.com' });
    const unknown = await forgot({ email: 'nobody@example.com' });

    expect(known.status).toBe(429);
    expect(known.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(known.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    expect(fingerprint(unknown)).toEqual(fingerprint(known));
  });

  it('answers a malformed body with 400 invalid_request', async () => {
    const bodies = [{}, { client_id: shop.clientId }, { client_id: shop.clientId, email: 5 }, { client_id: 7, email: 'a@b.co' }];
    for (const body of bodies) {
      const response = await request(server()).post('/api/v1/password/forgot').send(body);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_request');
    }
  });

  it('answers an unknown client with invalid_client and an app without both URLs with unconfigured_client', async () => {
    const legacy = await registerTestApp(app, 'Legacy', 'https://legacy.example', {
      emailConfirmationUrl: 'https://legacy.example/confirm',
      passwordResetUrl: null,
    });

    const unknown = await forgot({ client_id: 'app_missing' });
    const unconfigured = await forgot({ client_id: legacy.clientId });

    expect(unknown.body.error).toBe('invalid_client');
    expect(unconfigured.status).toBe(400);
    expect(unconfigured.body).toEqual({ error: 'unconfigured_client', message: 'This client is not configured to send email' });
  });

  describe('CORS bound to the client_id', () => {
    it('answers a preflight from an active app origin', async () => {
      const response = await request(server())
        .options('/api/v1/password/forgot')
        .set('Origin', SHOP_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('grants the allow header on the own origin and on a request-validation 400', async () => {
      const ok = await forgot().set('Origin', SHOP_ORIGIN);
      const malformed = await request(server()).post('/api/v1/password/forgot').send({}).set('Origin', SHOP_ORIGIN);

      expect(ok.status).toBe(202);
      expect(ok.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(malformed.status).toBe(400);
      expect(malformed.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('rejects the origin of another app like an unknown client, with no allow header and nothing queued', async () => {
      await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash });

      const wrong = await forgot({ email: 'confirmed@example.com' }).set('Origin', BLOG_ORIGIN);

      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe('invalid_client');
      expect(wrong.headers['access-control-allow-origin']).toBeUndefined();
      expect(await emails()).toEqual([]);
    });
  });
});
