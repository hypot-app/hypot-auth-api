import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { FixedClock } from '../../shared-kernel/clock';
import { anApp } from '../../../test/support/app-fixture';
import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import type { AccessTokenVerifier } from '../domain/access-token';
import { JoseAccessTokenIssuer } from '../infrastructure/jose-access-token-issuer';
import { JoseAccessTokenVerifier } from '../infrastructure/jose-access-token-verifier';
import { JwkSetKeyStore } from '../infrastructure/jwk-set-key-store';
import { generateKeySet, type KeySetJson } from '../infrastructure/signing-key-generator';
import { AuthenticateBearerUseCase } from './authenticate-bearer.use-case';

const ISSUER = 'https://auth.example.com';
const T0 = new Date('2026-03-03T10:00:00.000Z');
const NOW_SECONDS = T0.getTime() / 1000;
const SHOP_ORIGIN = 'https://shop.example';

const shop = anApp({ id: '11111111-1111-4111-8111-111111111111', clientId: 'app_shop', allowedOrigins: [SHOP_ORIGIN] });
const blog = anApp({ id: '22222222-2222-4222-8222-222222222222', clientId: 'app_blog', allowedOrigins: ['https://blog.example'] });
const parked = anApp({ id: '33333333-3333-4333-8333-333333333333', clientId: 'app_parked', status: 'inactive', allowedOrigins: ['https://parked.example'] });

const keySet = generateKeySet({ next: false });

function setup(keys: KeySetJson = keySet) {
  const clock = new FixedClock(T0);
  const keyStore = JwkSetKeyStore.fromJson(JSON.stringify(keys), { clock, warn: () => undefined });
  const apps = new InMemoryAppRepository();
  const issuer = new JoseAccessTokenIssuer({ keyStore, clock, issuer: ISSUER });
  const verifier = new JoseAccessTokenVerifier({ keyStore, clock, issuer: ISSUER });
  const verifyCalls: string[] = [];
  const spyVerifier: AccessTokenVerifier = {
    verify: (token, options) => {
      verifyCalls.push(token);
      return verifier.verify(token, options);
    },
  };
  const useCase = new AuthenticateBearerUseCase({ resolveClient: new ResolveClientUseCase(apps), verifier: spyVerifier });
  const signingKey = keyStore.activeSigningKey();

  /** A token the issuer would never produce, signed with the real key unless `key` says otherwise. */
  const forge = (
    options: { alg?: string; typ?: string | null; aud?: string | null; exp?: number; kid?: string | null; key?: Parameters<SignJWT['sign']>[0] } = {},
  ): Promise<string> => {
    const { alg = 'RS256', typ = 'at+jwt', aud = 'app_shop', exp = NOW_SECONDS + 3600, kid = signingKey.kid, key = signingKey.privateKey } = options;
    const jwt = new SignJWT({})
      .setProtectedHeader({ alg, ...(kid === null ? {} : { kid }), ...(typ === null ? {} : { typ }) })
      .setIssuer(ISSUER)
      .setSubject('user-ana')
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(exp)
      .setJti('jti-1');
    if (aud !== null) jwt.setAudience(aud);
    return jwt.sign(key);
  };
  const issue = async (clientId = 'app_shop', accountId = 'user-ana'): Promise<string> =>
    (await issuer.issue({ accountId, clientId })).token;
  const run = (authorization: string | undefined, origin?: string) => useCase.execute({ authorization, origin });
  const bearer = (token: string) => `Bearer ${token}`;

  return { clock, issue, forge, run, bearer, verifyCalls, ready: Promise.all([apps.save(shop), apps.save(blog), apps.save(parked)]) };
}

const UNAUTHORIZED = { ok: false, error: expect.objectContaining({ code: 'unauthorized' }) };

describe('AuthenticateBearerUseCase', () => {
  it('returns the account, app and client of a valid token', async () => {
    const t = setup();
    await t.ready;

    const result = await t.run(t.bearer(await t.issue()));

    expect(result).toEqual({ ok: true, value: { accountId: 'user-ana', appId: shop.id, clientId: 'app_shop' } });
  });

  it('accepts the scheme in any letter case, and a request with no Origin or the app origin', async () => {
    const t = setup();
    await t.ready;
    const token = await t.issue();

    expect((await t.run(`bearer ${token}`)).ok).toBe(true);
    expect((await t.run(`BEARER ${token}`, SHOP_ORIGIN)).ok).toBe(true);
  });

  describe('every failure is the same unauthorized', () => {
    it('gives one identical result for every cause', async () => {
      const t = setup();
      await t.ready;
      const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const hmac = new TextEncoder().encode('a-shared-secret-that-is-long-enough-32b');
      const unsigned = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${Buffer.from(
        JSON.stringify({ iss: ISSUER, aud: 'app_shop', sub: 'user-ana', iat: NOW_SECONDS, exp: NOW_SECONDS + 3600, jti: 'j' }),
      ).toString('base64url')}.`;
      const cases: [string, string | undefined, string?][] = [
        ['missing header', undefined],
        ['empty header', ''],
        ['wrong scheme', `Basic ${await t.issue()}`],
        ['scheme with no token', 'Bearer '],
        ['token with spaces', `Bearer ${await t.issue()} extra`],
        ['not a JWT', 'Bearer garbage'],
        ['expired', t.bearer(await t.forge({ exp: NOW_SECONDS - 3600 }))],
        ['bad signature', t.bearer(await t.forge({ key: attacker }))],
        ['alg none', t.bearer(unsigned)],
        ['HS256', t.bearer(await new SignJWT({ aud: 'app_shop' }).setProtectedHeader({ alg: 'HS256', kid: 'k', typ: 'at+jwt' }).setIssuer(ISSUER).setSubject('x').setIssuedAt(NOW_SECONDS).setExpirationTime(NOW_SECONDS + 3600).setJti('j').sign(hmac))],
        ['no aud', t.bearer(await t.forge({ aud: null }))],
        ['unknown aud', t.bearer(await t.forge({ aud: 'app_missing' }))],
        ['inactive aud', t.bearer(await t.forge({ aud: 'app_parked' }))],
        ['wrong typ', t.bearer(await t.forge({ typ: 'JWT' }))],
        ['no typ', t.bearer(await t.forge({ typ: null }))],
        ['origin of another app', t.bearer(await t.issue()), 'https://blog.example'],
        ['origin no app owns', t.bearer(await t.issue()), 'https://evil.example'],
      ];

      const results = await Promise.all(cases.map(([, authorization, origin]) => t.run(authorization, origin)));

      results.forEach((result, index) => {
        expect({ name: cases[index]![0], result }).toEqual({ name: cases[index]![0], result: UNAUTHORIZED });
      });
      for (const result of results) expect(result).toEqual(results[0]);
    });

    it('is identical in message too, so a caller cannot tell the causes apart', async () => {
      const t = setup();
      await t.ready;

      const missing = await t.run(undefined);
      const inactive = await t.run(t.bearer(await t.issue('app_parked')));

      expect(missing).toEqual(inactive);
      expect(missing.ok === false && missing.error.message).toBe('Missing or invalid access token');
    });
  });

  it('rejects a token for app A when the Origin belongs to app B', async () => {
    const t = setup();
    await t.ready;

    expect((await t.run(t.bearer(await t.issue('app_shop')), 'https://blog.example')).ok).toBe(false);
    expect((await t.run(t.bearer(await t.issue('app_blog')), 'https://blog.example')).ok).toBe(true);
  });

  it('does not run the verifier for a token whose audience is unknown, inactive or absent', async () => {
    const t = setup();
    await t.ready;

    await t.run(t.bearer(await t.forge({ aud: 'app_missing' })));
    await t.run(t.bearer(await t.forge({ aud: 'app_parked' })));
    await t.run(t.bearer(await t.forge({ aud: null })));
    await t.run(undefined);

    expect(t.verifyCalls).toEqual([]);
  });

  it('verifies against the token audience, so a token cannot be replayed for another app', async () => {
    const t = setup();
    await t.ready;

    await t.run(t.bearer(await t.issue('app_blog')));

    expect(t.verifyCalls).toHaveLength(1);
  });

  describe('signing keys', () => {
    const RETENTION_SECONDS = 3600 + 5 + 600;
    const retiredAgo = (seconds: number) => {
      const retired = generateKeySet({ next: false }).active;
      const keys: KeySetJson = {
        active: keySet.active,
        retired: [{ ...retired, retiredAt: new Date(T0.getTime() - seconds * 1000).toISOString() }],
      };
      return { keys, retired, retiredKid: retired['kid'] as string, retiredKey: createPrivateKey({ key: retired as never, format: 'jwk' }) };
    };

    it('refuses a token with a kid no key has, and a token with no kid, with the same unauthorized', async () => {
      const t = setup();
      await t.ready;

      const unknown = await t.run(t.bearer(await t.forge({ kid: 'no-such-key' })));
      const missing = await t.run(t.bearer(await t.forge({ kid: null })));

      expect(unknown).toEqual(UNAUTHORIZED);
      expect(missing).toEqual(unknown);
    });

    it('accepts a token signed by a retired key still within its retention', async () => {
      const { keys, retiredKid, retiredKey } = retiredAgo(RETENTION_SECONDS - 60);
      const t = setup(keys);
      await t.ready;

      const result = await t.run(t.bearer(await t.forge({ kid: retiredKid, key: retiredKey })));

      expect(result.ok).toBe(true);
    });

    it('refuses a token signed by a retired key past its retention, with the same unauthorized', async () => {
      const { keys, retiredKid, retiredKey } = retiredAgo(RETENTION_SECONDS + 60);
      const t = setup(keys);
      await t.ready;

      const result = await t.run(t.bearer(await t.forge({ kid: retiredKid, key: retiredKey })));

      expect(result).toEqual(UNAUTHORIZED);
    });
  });

  it('stops accepting a token once the clock passes its expiry', async () => {
    const t = setup();
    await t.ready;
    const header = t.bearer(await t.issue());

    expect((await t.run(header)).ok).toBe(true);
    t.clock.advanceMs(3600 * 1000 + 6_000);

    expect((await t.run(header)).ok).toBe(false);
  });
});
