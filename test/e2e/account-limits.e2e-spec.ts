import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { createTestApp } from '../support/create-test-app';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const SHOP_ORIGIN = 'https://shop.example';
const EMAIL_IP_LIMIT = 6;
const SIGNUP_TEXT = JSON.stringify({
  message: 'If this address can be registered, a confirmation email is on its way.',
});
const RESEND_TEXT = JSON.stringify({
  message: 'If an unconfirmed account exists for this address, a new confirmation email is on its way.',
});

describe('account limits, caps and unconfigured clients (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let hasher: FakePasswordHasher;
  let shop: App;

  const server = () => app.getHttpServer();
  const signup = (overrides: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/accounts/signup')
      .send({ client_id: shop.clientId, email: 'ana@example.com', password: 'correct horse', ...overrides });
  const resend = (overrides: Record<string, unknown> = {}) =>
    request(server())
      .post('/api/v1/accounts/resend-confirmation')
      .send({ client_id: shop.clientId, email: 'ana@example.com', ...overrides });
  const confirm = (token: string) => request(server()).post('/api/v1/accounts/confirm').send({ token });

  /** Everything a client can observe except the clock, so two answers can be compared byte for byte. */
  const fingerprint = (response: request.Response) => {
    const { date: _date, ...headers } = response.headers;
    return { status: response.status, text: response.text, headers };
  };
  const emails = (): Promise<{ to_address: string; template: string; payload: { token?: string } }[]> =>
    db.dataSource.query(`SELECT to_address, template, payload FROM email_outbox ORDER BY created_at, id`);
  const templatesFor = async (to: string): Promise<string[]> =>
    (await emails()).filter((email) => email.to_address === to).map((email) => email.template);
  const userEmails = async (): Promise<string[]> =>
    (await db.dataSource.query(`SELECT email FROM users ORDER BY created_at`)).map((row: { email: string }) => row.email);
  const latestToken = async (to: string): Promise<string> => {
    const token = (await emails()).filter((email) => email.to_address === to && email.template === 'confirmation').at(-1)
      ?.payload.token;
    if (token === undefined) throw new Error('no confirmation email was queued');
    return token;
  };

  const registerApp = async (
    name: string,
    origin: string,
    urls: { emailConfirmationUrl: string | null; passwordResetUrl: string | null } = {
      emailConfirmationUrl: `${origin}/confirm`,
      passwordResetUrl: `${origin}/reset`,
    },
  ): Promise<App> => {
    const now = new Date();
    const created = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name,
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [origin],
      emailFrom: null,
      ...urls,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(created);
    return created;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    hasher = new FakePasswordHasher();
    app = await createTestApp({
      databaseUrl: db.url,
      passwordHasher: hasher,
      abusePolicies: resolvePolicies({ email_ip: { limit: EMAIL_IP_LIMIT, windowSeconds: 3600 } }),
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    hasher.hashCalls = 0;
    shop = await registerApp('Shop', SHOP_ORIGIN);
  });

  describe('indistinguishable answers (17.6)', () => {
    it('answers a new, a duplicate and a capped signup byte for byte alike, with the fixed message', async () => {
      const first = await signup();
      const duplicate = await signup({ email: 'ANA@example.com' });
      const second = await signup({ password: 'another password' });
      const capped = await signup();

      for (const response of [first, duplicate, second, capped]) {
        expect(response.status).toBe(202);
        expect(response.text).toBe(SIGNUP_TEXT);
      }
      expect(fingerprint(duplicate)).toEqual(fingerprint(first));
      expect(fingerprint(second)).toEqual(fingerprint(first));
      expect(fingerprint(capped)).toEqual(fingerprint(first));
      // One confirmation, two account-exists notices, and nothing for the fourth request.
      expect(await templatesFor('ana@example.com')).toEqual(['confirmation', 'account-exists', 'account-exists']);
      expect(hasher.hashCalls).toBe(4);
    });

    it('does not let resends for an address with no account use up the cap, so a later signup is still confirmed', async () => {
      const ghostResends = [];
      for (let i = 0; i < 4; i += 1) ghostResends.push(await resend({ email: 'ghost@example.com' }));
      const reference = await signup({ email: 'other@example.com' });

      const later = await signup({ email: 'ghost@example.com' });

      expect(ghostResends.map((response) => response.text)).toEqual(Array(4).fill(RESEND_TEXT));
      expect(fingerprint(later)).toEqual(fingerprint(reference));
      expect(await templatesFor('ghost@example.com')).toEqual(['confirmation']);
      expect(await templatesFor('other@example.com')).toEqual(['confirmation']);
    });

    it('answers resend byte for byte alike for an unconfirmed, a confirmed, an unknown and a capped address', async () => {
      await signup();
      const unconfirmed = await resend();
      await resend();
      const capped = await resend();
      const unknown = await resend({ email: 'nobody@example.com' });
      expect((await confirm(await latestToken('ana@example.com'))).status).toBe(200);
      const confirmed = await resend();

      for (const response of [unconfirmed, unknown, confirmed, capped]) {
        expect(response.status).toBe(202);
        expect(response.text).toBe(RESEND_TEXT);
      }
      expect(fingerprint(unknown)).toEqual(fingerprint(unconfirmed));
      expect(fingerprint(confirmed)).toEqual(fingerprint(unconfirmed));
      expect(fingerprint(capped)).toEqual(fingerprint(unconfirmed));
      // Signup and two resends used the 3 allowed emails; the capped, unknown and confirmed requests queued nothing.
      expect(await templatesFor('ana@example.com')).toEqual(['confirmation', 'confirmation', 'confirmation', 'welcome']);
    });

    it('gives every error body a string error and a string message', async () => {
      const legacy = await registerApp('Legacy', 'https://legacy.example', {
        emailConfirmationUrl: 'https://legacy.example/confirm',
        passwordResetUrl: null,
      });
      const responses = [
        await request(server()).post('/api/v1/accounts/signup').send({}),
        await signup({ email: 'not-an-email' }),
        await signup({ password: 'short' }),
        await signup({ client_id: 'app_unknown' }),
        await signup({ client_id: legacy.clientId }),
        await resend({ client_id: legacy.clientId }),
        await request(server()).post('/api/v1/accounts/confirm').send({}),
        await confirm('nope'),
      ];

      expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400, 400, 400]);
      for (const response of responses) {
        expect(response.body).toEqual({ error: expect.any(String), message: expect.any(String) });
      }
    });

    it('gives the 429 the same shape: a string error, a string message and an integer Retry-After', async () => {
      for (let i = 0; i < EMAIL_IP_LIMIT; i += 1) await signup({ email: `user${i}@example.com` });

      const limited = await signup();

      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
      expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    });
  });

  describe('email_ip limit (17.4)', () => {
    it('answers 429 the same for a new and an existing email, runs no hash and changes nothing', async () => {
      for (let i = 0; i < EMAIL_IP_LIMIT - 1; i += 1) await signup({ email: `user${i}@example.com` });
      await signup();
      const hashed = hasher.hashCalls;
      const before = { users: await userEmails(), emails: (await emails()).length };

      const existing = await signup({ email: 'ana@example.com' });
      const brandNew = await signup({ email: 'brand-new@example.com' });
      const resendLimited = await resend({ email: 'ana@example.com' });

      expect(existing.status).toBe(429);
      expect(brandNew.status).toBe(429);
      expect(resendLimited.status).toBe(429);
      expect(brandNew.body).toEqual(existing.body);
      expect(resendLimited.body).toEqual(existing.body);
      const retryAfter = [existing, brandNew].map((response) => Number(response.headers['retry-after']));
      expect(Number.isInteger(retryAfter[0])).toBe(true);
      expect(Math.abs(retryAfter[0]! - retryAfter[1]!)).toBeLessThanOrEqual(1);
      expect(retryAfter[0]).toBeLessThanOrEqual(3600);
      expect(hasher.hashCalls).toBe(hashed);
      expect({ users: await userEmails(), emails: (await emails()).length }).toEqual(before);
    });

    it('lets a browser on the app origin read the 429', async () => {
      for (let i = 0; i < EMAIL_IP_LIMIT; i += 1) await signup({ email: `user${i}@example.com` });

      const limited = await signup().set('Origin', SHOP_ORIGIN);

      expect(limited.status).toBe(429);
      expect(limited.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
    });

    it('fails closed with a 503 before any account work when the counter table is unavailable', async () => {
      await db.dataSource.query('ALTER TABLE abuse_counters RENAME TO abuse_counters_off');
      try {
        const signedUp = await signup();
        const resent = await resend();

        for (const response of [signedUp, resent]) {
          expect(response.status).toBe(503);
          expect(response.body).toEqual({
            error: 'temporarily_unavailable',
            message: 'The service is temporarily unavailable. Try again later.',
          });
        }
        expect(await userEmails()).toEqual([]);
        expect(await emails()).toEqual([]);
        expect(hasher.hashCalls).toBe(0);
      } finally {
        await db.dataSource.query('ALTER TABLE abuse_counters_off RENAME TO abuse_counters');
      }
    });
  });

  describe('unconfigured clients (17.5)', () => {
    const UNCONFIGURED = {
      error: 'unconfigured_client',
      message: 'This client is not configured to send email',
    };

    it.each([
      ['no email URL', null, null],
      ['only email_confirmation_url', 'https://legacy.example/confirm', null],
      ['only password_reset_url', null, 'https://legacy.example/reset'],
    ])('answers 400 unconfigured_client for an app with %s, before any account work', async (_label, confirmUrl, resetUrl) => {
      const legacy = await registerApp('Legacy', 'https://legacy.example', {
        emailConfirmationUrl: confirmUrl,
        passwordResetUrl: resetUrl,
      });

      const signedUp = await signup({ client_id: legacy.clientId });
      const resent = await resend({ client_id: legacy.clientId });

      for (const response of [signedUp, resent]) {
        expect([response.status, response.body]).toEqual([400, UNCONFIGURED]);
      }
      expect(await userEmails()).toEqual([]);
      expect(await emails()).toEqual([]);
      expect(hasher.hashCalls).toBe(0);
    });

    it("lets the app's own origin read the unconfigured_client answer, since the origin is bound to the app", async () => {
      const legacy = await registerApp('Legacy', 'https://legacy.example', {
        emailConfirmationUrl: null,
        passwordResetUrl: null,
      });

      const response = await signup({ client_id: legacy.clientId }).set('Origin', 'https://legacy.example');

      expect([response.status, response.body]).toEqual([400, UNCONFIGURED]);
      expect(response.headers['access-control-allow-origin']).toBe('https://legacy.example');
    });
  });
});
