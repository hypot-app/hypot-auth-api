import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import request from 'supertest';
import type { App } from '../../src/app-registry/domain/app';
import { buildOpenApiDocument } from '../../src/openapi/openapi-document';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { FixedClock } from '../../src/shared-kernel/clock';
import { OutboxWorker } from '../../src/transactional-email/application/outbox-worker';
import type { EmailMessage } from '../../src/transactional-email/domain/email-sender';
import { BcryptPasswordHasher } from '../../src/user-accounts/infrastructure/bcrypt-password-hasher';
import { createTestApp } from '../support/create-test-app';
import { addTestUser, fingerprint, registerTestApp } from '../support/e2e-fixtures';
import { FakeEmailSender } from '../support/fake-email-sender';
import { LowCostPasswordHasher } from '../support/low-cost-password-hasher';
import { expectDocumented } from '../support/openapi-conformance';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const version = (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
const document = buildOpenApiDocument({ version });

const SHOP_ORIGIN = 'https://shop.example';
const BLOG_ORIGIN = 'https://blog.example';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse';
const SECOND_MS = 1000;

interface Pair {
  access: string;
  refresh: string;
}

describe('end-to-end journeys (e2e, 19.6)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  let blog: App;
  let clock: FixedClock;
  const sender = new FakeEmailSender();

  const server = () => app.getHttpServer();
  const rows = (sql: string, params: unknown[] = []): Promise<any[]> => db.dataSource.query(sql, params);

  const call = (method: 'post' | 'get', path: string, options: { body?: object; origin?: string; bearer?: string } = {}) => {
    const req = request(server())[method](path);
    if (options.origin !== undefined) req.set('Origin', options.origin);
    if (options.bearer !== undefined) req.set('Authorization', `Bearer ${options.bearer}`);
    return method === 'post' ? req.send(options.body ?? {}) : req;
  };
  /** Sends the request and checks the answer against the OpenAPI document before returning it. */
  const documented = async (method: 'post' | 'get', path: string, options: Parameters<typeof call>[2] = {}) => {
    const response = await call(method, path, options);
    expectDocumented(document, response, method, path);
    return response;
  };

  const signup = (target: App, origin: string, email: string, password = PASSWORD) =>
    documented('post', '/api/v1/accounts/signup', { origin, body: { client_id: target.clientId, email, password } });
  const login = (target: App, origin: string, email: string, password = PASSWORD) =>
    documented('post', '/api/v1/auth/login', { origin, body: { client_id: target.clientId, email, password } });
  const refresh = (target: App, origin: string, token: string) =>
    documented('post', '/api/v1/auth/refresh', { origin, body: { client_id: target.clientId, refresh_token: token } });
  const forgot = (target: App, origin: string, email: string) =>
    documented('post', '/api/v1/password/forgot', { origin, body: { client_id: target.clientId, email } });
  const me = (access: string, origin: string) => documented('get', '/api/v1/me', { origin, bearer: access });
  const pairOf = (response: request.Response): Pair => ({ access: response.body.access_token, refresh: response.body.refresh_token });

  /** Delivers everything queued in the outbox to the fake sender and returns the new messages for `to`. */
  const mailTo = async (to: string): Promise<EmailMessage[]> => {
    const delivered = sender.sent.length;
    await app.get(OutboxWorker).drain(100);
    return sender.sent.slice(delivered).filter((message) => message.to === to);
  };
  const fragmentToken = (message: EmailMessage): string => {
    const token = /#token=([A-Za-z0-9_-]+)/.exec(message.text)?.[1];
    if (token === undefined) throw new Error(`no #token fragment in:\n${message.text}`);
    return token;
  };
  const sessionStates = async (): Promise<(string | null)[]> =>
    (await rows(`SELECT revoked_reason FROM auth_sessions ORDER BY created_at, id`)).map((row) => row.revoked_reason);

  /** Signs up, reads the mail, confirms with the fragment token and logs in: what a real SPA does. */
  async function signedUp(target: App, origin: string, email: string, password = PASSWORD): Promise<Pair> {
    await signup(target, origin, email, password).then((response) => expect(response.status).toBe(202));
    const [confirmation] = await mailTo(email);
    await documented('post', '/api/v1/accounts/confirm', { origin, body: { token: fragmentToken(confirmation!) } }).then((r) => expect(r.status).toBe(200));
    const response = await login(target, origin, email, password);
    expect(response.status).toBe(200);
    // The welcome mail queued by the confirmation is delivered now, so it does not show up in a later read.
    await mailTo(email);
    return pairOf(response);
  }

  beforeAll(async () => {
    db = await startTestDatabase();
    clock = new FixedClock(new Date());
    app = await createTestApp({ databaseUrl: db.url, clock, passwordHasher: new LowCostPasswordHasher(), emailSender: sender });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    sender.sent.length = 0;
    [shop, blog] = [await registerTestApp(app, 'Shop', SHOP_ORIGIN), await registerTestApp(app, 'Blog', BLOG_ORIGIN)];
  });

  it('runs signup, confirm, login, /me, refresh and logout like a browser app, with every answer documented', async () => {
    const created = await signup(shop, SHOP_ORIGIN, 'Ana@Example.com');
    expect(created.status).toBe(202);
    const [confirmation] = await mailTo('ana@example.com');
    expect(confirmation!.text).toContain(`${SHOP_ORIGIN}/confirm#token=`);

    // Not confirmed yet: the generic login failure.
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com')).status).toBe(401);

    const token = fragmentToken(confirmation!);
    expect((await documented('post', '/api/v1/accounts/confirm', { origin: SHOP_ORIGIN, body: { token } })).status).toBe(200);
    const again = await documented('post', '/api/v1/accounts/confirm', { origin: SHOP_ORIGIN, body: { token } });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_or_expired_link');
    expect((await mailTo('ana@example.com')).map((message) => message.subject)).toEqual(['Welcome to Shop']);

    const logged = await login(shop, SHOP_ORIGIN, 'ana@example.com');
    expect(logged.status).toBe(200);
    expect(logged.headers['set-cookie']).toBeUndefined();
    const first = pairOf(logged);
    // expires_in is the real access token lifetime, not a second constant (api-contract: 3600).
    const claims = decodeJwt(first.access);
    expect(claims.exp! - claims.iat!).toBe(logged.body.expires_in);

    const profile = await me(first.access, SHOP_ORIGIN);
    expect(profile.status).toBe(200);
    expect(Object.keys(profile.body).sort()).toEqual(['created_at', 'email', 'email_verified', 'id']);
    expect(profile.body).toMatchObject({ email: 'ana@example.com', email_verified: true });
    expect(profile.body.id).toBe(decodeJwt(first.access).sub);

    const rotated = await refresh(shop, SHOP_ORIGIN, first.refresh);
    expect(rotated.status).toBe(200);
    expect(pairOf(rotated).refresh).not.toBe(first.refresh);

    const out = await documented('post', '/api/v1/auth/logout', { origin: SHOP_ORIGIN, body: { client_id: shop.clientId, refresh_token: pairOf(rotated).refresh } });
    expect(out.status).toBe(204);
    expect((await refresh(shop, SHOP_ORIGIN, pairOf(rotated).refresh)).status).toBe(401);
    expect(await sessionStates()).toEqual(['logout']);
  });

  describe('refresh reuse', () => {
    it('keeps the session when a lost response is retried inside the grace window, and revokes it on a replay after the window', async () => {
      const first = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
      const r2 = pairOf(await refresh(shop, SHOP_ORIGIN, first.refresh));

      // The response carrying r2 was lost: the app retries the token it still holds, once, from the same network.
      clock.advanceMs(3 * SECOND_MS);
      const retried = await refresh(shop, SHOP_ORIGIN, first.refresh);
      expect(retried.status).toBe(200);
      const r3 = pairOf(retried);
      expect(await sessionStates()).toEqual([null]);
      expect((await refresh(shop, SHOP_ORIGIN, r3.refresh)).status).toBe(200);

      // Replaying the same old token later is theft: the whole session dies, the newest token with it.
      clock.advanceMs(11 * SECOND_MS);
      const replay = await refresh(shop, SHOP_ORIGIN, first.refresh);
      expect(replay.status).toBe(401);
      expect(await sessionStates()).toEqual(['reuse_detected']);
      expect(r2.refresh).not.toBe(r3.refresh);
      expect((await refresh(shop, SHOP_ORIGIN, r3.refresh)).status).toBe(401);
    });

    it('revokes the session when a rotated token comes back after the grace window', async () => {
      const first = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
      const rotated = pairOf(await refresh(shop, SHOP_ORIGIN, first.refresh));

      clock.advanceMs(11 * SECOND_MS);
      const replay = await refresh(shop, SHOP_ORIGIN, first.refresh);

      expect(replay.status).toBe(401);
      expect(await sessionStates()).toEqual(['reuse_detected']);
      expect((await refresh(shop, SHOP_ORIGIN, rotated.refresh)).status).toBe(401);
    });
  });

  it('turns a forgot for an unconfirmed account into a confirmation mail that confirms it', async () => {
    await signup(shop, SHOP_ORIGIN, 'ana@example.com');
    await mailTo('ana@example.com');
    sender.sent.length = 0;

    expect((await forgot(shop, SHOP_ORIGIN, 'ana@example.com')).status).toBe(202);
    const mails = await mailTo('ana@example.com');
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain(`${SHOP_ORIGIN}/confirm#token=`);
    expect(mails[0]!.text).not.toContain('reset');

    await documented('post', '/api/v1/accounts/confirm', { origin: SHOP_ORIGIN, body: { token: fragmentToken(mails[0]!) } }).then((r) => expect(r.status).toBe(200));
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com')).status).toBe(200);
  });

  it('answers a wrong current password on change with 400 invalid_current_password and changes nothing', async () => {
    const pair = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');

    const wrong = await documented('post', '/api/v1/password/change', {
      origin: SHOP_ORIGIN,
      bearer: pair.access,
      body: { current_password: 'not the password', new_password: NEW_PASSWORD },
    });

    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_current_password');
    expect(await sessionStates()).toEqual([null]);
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com')).status).toBe(200);
  });

  it('resets a forgotten password: old sessions die, the old password stops working, the new one logs in', async () => {
    const old = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
    sender.sent.length = 0;

    expect((await forgot(shop, SHOP_ORIGIN, 'ana@example.com')).status).toBe(202);
    const [resetMail] = await mailTo('ana@example.com');
    expect(resetMail!.text).toContain(`${SHOP_ORIGIN}/reset#token=`);
    const reset = await documented('post', '/api/v1/password/reset', {
      origin: SHOP_ORIGIN,
      body: { token: fragmentToken(resetMail!), new_password: NEW_PASSWORD },
    });
    expect(reset.status).toBe(204);

    expect((await refresh(shop, SHOP_ORIGIN, old.refresh)).status).toBe(401);
    expect(await sessionStates()).toEqual(['password_reset']);
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com', PASSWORD)).status).toBe(401);
    const fresh = await login(shop, SHOP_ORIGIN, 'ana@example.com', NEW_PASSWORD);
    expect(fresh.status).toBe(200);
    expect((await me(pairOf(fresh).access, SHOP_ORIGIN)).status).toBe(200);
  });

  it('changes the password of a signed-in account: every session dies, a notice is mailed, the new password logs in', async () => {
    const old = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
    sender.sent.length = 0;

    const changed = await documented('post', '/api/v1/password/change', {
      origin: SHOP_ORIGIN,
      bearer: old.access,
      body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
    });

    expect(changed.status).toBe(204);
    expect((await refresh(shop, SHOP_ORIGIN, old.refresh)).status).toBe(401);
    expect(await sessionStates()).toEqual(['password_changed']);
    const [notice] = await mailTo('ana@example.com');
    expect(notice!.subject.toLowerCase()).toContain('password');
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com', PASSWORD)).status).toBe(401);
    expect((await login(shop, SHOP_ORIGIN, 'ana@example.com', NEW_PASSWORD)).status).toBe(200);
  });

  describe('two apps with the same email', () => {
    it('keeps accounts, tokens and sessions of each app apart', async () => {
      const shopPair = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com', PASSWORD);
      const blogPair = await signedUp(blog, BLOG_ORIGIN, 'ana@example.com', NEW_PASSWORD);

      const shopMe = await me(shopPair.access, SHOP_ORIGIN);
      const blogMe = await me(blogPair.access, BLOG_ORIGIN);
      expect(shopMe.body.id).not.toBe(blogMe.body.id);
      expect(decodeJwt(shopPair.access).aud).toBe(shop.clientId);
      expect(decodeJwt(blogPair.access).aud).toBe(blog.clientId);

      // One app's password does not log in to the other app.
      expect((await login(blog, BLOG_ORIGIN, 'ana@example.com', PASSWORD)).status).toBe(401);
      // A token of one app is refused from the other app's origin, and a refresh token under the other client id.
      expect((await me(shopPair.access, BLOG_ORIGIN)).status).toBe(401);
      expect((await refresh(blog, BLOG_ORIGIN, shopPair.refresh)).status).toBe(401);
      const crossChange = await documented('post', '/api/v1/password/change', {
        origin: BLOG_ORIGIN,
        bearer: shopPair.access,
        body: { current_password: PASSWORD, new_password: NEW_PASSWORD },
      });
      expect(crossChange.status).toBe(401);

      // The failed cross-app attempts revoked nothing and changed nothing.
      expect(await sessionStates()).toEqual([null, null]);
      expect((await refresh(shop, SHOP_ORIGIN, shopPair.refresh)).status).toBe(200);
      expect((await me(blogPair.access, BLOG_ORIGIN)).status).toBe(200);
    });

    it('sends nothing for a forgot at an app where the address does not exist', async () => {
      await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
      sender.sent.length = 0;

      expect((await forgot(blog, BLOG_ORIGIN, 'ana@example.com')).status).toBe(202);

      expect(await mailTo('ana@example.com')).toEqual([]);
    });
  });

  it('verifies the audience from the published JWKS alone: the right app accepts the token, another app refuses it', async () => {
    const pair = await signedUp(shop, SHOP_ORIGIN, 'ana@example.com');
    const jwks = await request(server()).get('/.well-known/jwks.json').expect(200);
    const keys = createLocalJWKSet(jwks.body);
    const options = { issuer: 'http://localhost:3000', algorithms: ['RS256'], typ: 'at+jwt', currentDate: clock.now() };

    const accepted = await jwtVerify(pair.access, keys, { ...options, audience: shop.clientId });
    expect(accepted.payload.sub).toBe(decodeJwt(pair.access).sub);
    await expect(jwtVerify(pair.access, keys, { ...options, audience: blog.clientId })).rejects.toMatchObject({ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED' });
  });

  describe('anti-enumeration: the same status, body and headers whether or not the account exists', () => {
    beforeEach(async () => {
      const hash = await new LowCostPasswordHasher().hash(PASSWORD);
      await addTestUser(app, { appId: shop.id, email: 'confirmed@example.com', passwordHash: hash });
      await addTestUser(app, { appId: shop.id, email: 'pending@example.com', passwordHash: hash, confirmed: false });
    });

    it('login: unknown email, wrong password and unconfirmed account', async () => {
      const unknown = await login(shop, SHOP_ORIGIN, 'nobody@example.com');
      const wrong = await login(shop, SHOP_ORIGIN, 'confirmed@example.com', 'wrong password');
      const pending = await login(shop, SHOP_ORIGIN, 'pending@example.com');

      expect(unknown.status).toBe(401);
      expect(fingerprint(wrong)).toEqual(fingerprint(unknown));
      expect(fingerprint(pending)).toEqual(fingerprint(unknown));
    });

    it('forgot: unknown, confirmed and unconfirmed addresses', async () => {
      const unknown = await forgot(shop, SHOP_ORIGIN, 'nobody@example.com');
      const confirmed = await forgot(shop, SHOP_ORIGIN, 'confirmed@example.com');
      const pending = await forgot(shop, SHOP_ORIGIN, 'pending@example.com');

      expect(unknown.status).toBe(202);
      expect(fingerprint(confirmed)).toEqual(fingerprint(unknown));
      expect(fingerprint(pending)).toEqual(fingerprint(unknown));
    });

    it('signup: a new address and an existing one', async () => {
      const fresh = await signup(shop, SHOP_ORIGIN, 'brand-new@example.com');
      const existing = await signup(shop, SHOP_ORIGIN, 'confirmed@example.com');

      expect(fresh.status).toBe(202);
      expect(fingerprint(existing)).toEqual(fingerprint(fresh));
    });

    it('resend: unknown, unconfirmed and confirmed addresses', async () => {
      const resend = (email: string) =>
        documented('post', '/api/v1/accounts/resend-confirmation', { origin: SHOP_ORIGIN, body: { client_id: shop.clientId, email } });
      const unknown = await resend('nobody@example.com');
      const pending = await resend('pending@example.com');
      const confirmed = await resend('confirmed@example.com');

      expect(unknown.status).toBe(202);
      expect(fingerprint(pending)).toEqual(fingerprint(unknown));
      expect(fingerprint(confirmed)).toEqual(fingerprint(unknown));
    });
  });
});

describe('anti-enumeration timing at bcrypt cost 12 (e2e, 19.6)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let shop: App;
  const SAMPLES = 5;
  /** Generous on purpose: the property is "no bcrypt-sized gap" (about 250 ms), not equal microseconds. */
  const TOLERANCE_RATIO = 0.5;

  const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  async function timed(send: () => PromiseLike<unknown>): Promise<number> {
    const start = process.hrtime.bigint();
    await send();
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  /** Alternates the two requests so a slow moment of the machine hits both samples. */
  async function medians(a: () => PromiseLike<unknown>, b: () => PromiseLike<unknown>): Promise<[number, number]> {
    const first: number[] = [];
    const second: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      first.push(await timed(a));
      second.push(await timed(b));
    }
    return [median(first), median(second)];
  }
  const expectClose = ([a, b]: [number, number]) => {
    expect(Math.abs(a - b)).toBeLessThan(Math.max(a, b) * TOLERANCE_RATIO);
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    // The default hasher: cost 12, like production.
    app = await createTestApp({ databaseUrl: db.url, abusePolicies: resolvePolicies({ email_account: { limit: 1000 }, login_account_ip: { limit: 1000 } }) });
    shop = await registerTestApp(app, 'Shop', SHOP_ORIGIN);
    await addTestUser(app, { appId: shop.id, email: 'ana@example.com', passwordHash: await new BcryptPasswordHasher().hash(PASSWORD) });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  it('login takes about as long for an unknown email as for a known email with a wrong password', async () => {
    const post = (email: string) => request(app.getHttpServer()).post('/api/v1/auth/login').send({ client_id: shop.clientId, email, password: 'wrong password' });

    const result = await medians(
      () => post('nobody@example.com'),
      () => post('ana@example.com'),
    );

    expect(result[0]).toBeGreaterThan(100);
    expectClose(result);
  }, 120_000);

  it('signup takes about as long for an existing address as for a new one', async () => {
    let counter = 0;
    const post = (email: string) => request(app.getHttpServer()).post('/api/v1/accounts/signup').send({ client_id: shop.clientId, email, password: PASSWORD });

    const result = await medians(
      () => post(`new-${counter++}@example.com`),
      () => post('ana@example.com'),
    );

    expect(result[0]).toBeGreaterThan(100);
    expectClose(result);
  }, 120_000);
});
