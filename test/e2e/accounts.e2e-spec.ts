import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { App } from '../../src/app-registry/domain/app';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

interface UserRow {
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  app_id: string;
}
interface OutboxRow {
  to_address: string;
  template: string;
  payload: { token?: string };
}

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const SIGNUP_BODY = {
  message: 'If this address can be registered, a confirmation email is on its way.',
};
const RESEND_BODY = {
  message: 'If an unconfirmed account exists for this address, a new confirmation email is on its way.',
};
const INVALID_LINK = {
  error: 'invalid_or_expired_link',
  message: 'The confirmation link is invalid or has expired',
};

describe('account routes (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;

  const server = () => app.getHttpServer();
  const signup = (body: Record<string, unknown>) => request(server()).post('/api/v1/accounts/signup').send(body);
  const resend = (body: Record<string, unknown>) =>
    request(server()).post('/api/v1/accounts/resend-confirmation').send(body);
  const confirm = (token: string) => request(server()).get('/api/v1/accounts/confirm').query({ token });
  const credentials = (overrides: Record<string, unknown> = {}) => ({
    client_id: shop.clientId,
    email: 'Ana@Example.com',
    password: 'correct horse',
    ...overrides,
  });
  const users = (): Promise<UserRow[]> =>
    db.dataSource.query(`SELECT email, password_hash, email_verified_at, app_id FROM users ORDER BY created_at`);
  const outbox = (template: string): Promise<OutboxRow[]> =>
    db.dataSource.query(
      `SELECT to_address, template, payload FROM email_outbox WHERE template = $1 ORDER BY created_at`,
      [template],
    );
  const latestToken = async (): Promise<string> => {
    const token = (await outbox('confirmation')).at(-1)?.payload.token;
    if (token === undefined) throw new Error('no confirmation email was queued');
    return token;
  };

  const registerApp = async (name: string, origin: string): Promise<App> => {
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
      emailConfirmationUrl: null,
      passwordResetUrl: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(created);
    return created;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({ databaseUrl: db.url });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    [shop, blog] = [await registerApp('Shop', SHOP_ORIGIN), await registerApp('Blog', BLOG_ORIGIN)];
  });

  describe('browser origin binding (ADR 38)', () => {
    const INVALID_CLIENT = { error: 'invalid_client', message: 'Unknown or inactive client' };

    it.each(['signup', 'resend-confirmation'])('answers a preflight for %s from any active app origin', async (route) => {
      const response = await request(server())
        .options(`/api/v1/accounts/${route}`)
        .set('Origin', BLOG_ORIGIN)
        .set('Access-Control-Request-Method', 'POST');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(BLOG_ORIGIN);
    });

    it('refuses a preflight from an origin no active app owns', async () => {
      const response = await request(server())
        .options('/api/v1/accounts/signup')
        .set('Origin', 'https://nobody.example')
        .set('Access-Control-Request-Method', 'POST');

      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-methods']).toBeUndefined();
    });

    it("signs up from the app's own origin with the allow header and no credentials header", async () => {
      const response = await signup(credentials()).set('Origin', SHOP_ORIGIN);

      expect(response.status).toBe(202);
      expect(response.headers['access-control-allow-origin']).toBe(SHOP_ORIGIN);
      expect(response.headers['vary']).toMatch(/Origin/);
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
      expect(await users()).toHaveLength(1);
    });

    it('signs up without an Origin header (a backend caller)', async () => {
      const response = await signup(credentials());

      expect(response.status).toBe(202);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it.each([
      ['signup', (origin: string) => signup(credentials({ client_id: blog.clientId })).set('Origin', origin)],
      [
        'resend-confirmation',
        (origin: string) => resend({ client_id: blog.clientId, email: 'ana@example.com' }).set('Origin', origin),
      ],
    ])("rejects %s from another app's origin like an unknown client, with no allow header", async (_route, call) => {
      const wrongApp = await call(SHOP_ORIGIN);

      expect(wrongApp.status).toBe(400);
      expect(wrongApp.body).toEqual(INVALID_CLIENT);
      expect(wrongApp.headers['access-control-allow-origin']).toBeUndefined();
      expect(await users()).toEqual([]);
    });

    it('answers an unknown client_id from a known origin with the same body and no allow header', async () => {
      const response = await signup(credentials({ client_id: 'app_unknown' })).set('Origin', SHOP_ORIGIN);

      expect(response.status).toBe(400);
      expect(response.body).toEqual(INVALID_CLIENT);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('POST /api/v1/accounts/signup', () => {
    it('creates an unconfirmed account with a cost-12 bcrypt hash and queues the confirmation email', async () => {
      const response = await signup(credentials());

      expect(response.status).toBe(202);
      expect(response.body).toEqual(SIGNUP_BODY);
      const [user, ...rest] = await users();
      expect(rest).toEqual([]);
      expect(user?.email).toBe('ana@example.com');
      expect(user?.email_verified_at).toBeNull();
      expect(user?.password_hash).toMatch(/^\$2b\$12\$/);
      expect(user?.password_hash).not.toContain('correct horse');
      const [email] = await outbox('confirmation');
      expect(email?.to_address).toBe('ana@example.com');
      expect(email?.payload.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(response.body)).not.toContain(email?.payload.token);
    });

    it('answers a duplicate in the same app exactly like a signup and notifies the owner instead', async () => {
      const first = await signup(credentials());
      const second = await signup(credentials({ email: 'ANA@example.com', password: 'a different one' }));

      expect([second.status, second.body]).toEqual([first.status, first.body]);
      expect(await users()).toHaveLength(1);
      expect(await outbox('confirmation')).toHaveLength(1);
      const [notice, ...rest] = await outbox('account-exists');
      expect(rest).toEqual([]);
      expect(notice).toMatchObject({ to_address: 'ana@example.com', payload: {} });
    });

    it('keeps the same email in two apps as independent accounts', async () => {
      await signup(credentials({ password: 'first password' }));
      await signup(credentials({ client_id: blog.clientId, password: 'second password' }));

      const rows = await users();
      expect(rows.map((row) => row.app_id).sort()).toEqual([shop.id, blog.id].sort());
      expect(rows[0]?.password_hash).not.toBe(rows[1]?.password_hash);
    });

    it.each([
      ['an unknown client', { client_id: 'app_unknown' }, { error: 'invalid_client', message: 'Unknown or inactive client' }],
      ['a malformed email', { email: 'not-an-email' }, { error: 'invalid_email', message: 'Email address is not valid' }],
      ['a short password', { password: 'short' }, { error: 'invalid_password', message: 'Password must be at least 8 characters' }],
      ['a password over 72 bytes', { password: 'é'.repeat(37) }, { error: 'invalid_password', message: 'Password must be at most 72 bytes' }],
      ['a missing password', { password: undefined }, { error: 'invalid_request', message: 'client_id, email and password must be strings' }],
      ['a non-string email', { email: ['a@b.co'] }, { error: 'invalid_request', message: 'client_id, email and password must be strings' }],
      ['an oversized client_id', { client_id: 'a'.repeat(129) }, { error: 'invalid_request', message: 'client_id, email and password must be strings' }],
    ])('answers 400 for %s and creates nothing', async (_label, overrides, body) => {
      const response = await signup(credentials(overrides));

      expect(response.status).toBe(400);
      expect(response.body).toEqual(body);
      expect(await users()).toEqual([]);
    });
  });

  describe('GET /api/v1/accounts/confirm', () => {
    it('confirms the account from the emailed token, queues the welcome email and refuses a second use', async () => {
      await signup(credentials());
      const token = await latestToken();

      const response = await confirm(token);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ message: 'Your email address is confirmed.' });
      expect((await users())[0]?.email_verified_at).toEqual(expect.any(Date));
      expect(await outbox('welcome')).toMatchObject([{ to_address: 'ana@example.com' }]);

      const again = await confirm(token);
      expect([again.status, again.body]).toEqual([400, INVALID_LINK]);
      expect(await outbox('welcome')).toHaveLength(1);
    });

    it.each([['a token never issued', 'A'.repeat(43)], ['a malformed token', 'nope']])(
      'answers %s with the generic invalid link error',
      async (_label, token) => {
        await signup(credentials());

        const response = await confirm(token);

        expect([response.status, response.body]).toEqual([400, INVALID_LINK]);
        expect((await users())[0]?.email_verified_at).toBeNull();
      },
    );

    it('answers a missing token and a repeated token parameter with the same generic error', async () => {
      const missing = await request(server()).get('/api/v1/accounts/confirm');
      const repeated = await request(server()).get('/api/v1/accounts/confirm?token=a&token=b');

      expect([missing.status, missing.body]).toEqual([400, INVALID_LINK]);
      expect([repeated.status, repeated.body]).toEqual([400, INVALID_LINK]);
    });
  });

  describe('POST /api/v1/accounts/resend-confirmation', () => {
    it('issues a new token that replaces the old one', async () => {
      await signup(credentials());
      const oldToken = await latestToken();

      const response = await resend({ client_id: shop.clientId, email: 'ANA@example.com' });

      expect([response.status, response.body]).toEqual([202, RESEND_BODY]);
      const newToken = await latestToken();
      expect(newToken).not.toBe(oldToken);
      expect((await confirm(oldToken)).status).toBe(400);
      expect((await confirm(newToken)).status).toBe(200);
    });

    it('answers an unknown email and a confirmed account exactly like a real resend, queuing nothing', async () => {
      await signup(credentials());
      await confirm(await latestToken());
      const before = (await outbox('confirmation')).length;

      const unknown = await resend({ client_id: shop.clientId, email: 'nobody@example.com' });
      const confirmed = await resend({ client_id: shop.clientId, email: 'ana@example.com' });

      expect([unknown.status, unknown.body]).toEqual([202, RESEND_BODY]);
      expect([confirmed.status, confirmed.body]).toEqual([202, RESEND_BODY]);
      expect(await outbox('confirmation')).toHaveLength(before);
    });

    it('answers 400 for an unknown client', async () => {
      const response = await resend({ client_id: 'app_unknown', email: 'ana@example.com' });
      expect([response.status, response.body]).toEqual([
        400,
        { error: 'invalid_client', message: 'Unknown or inactive client' },
      ]);
    });
  });
});
