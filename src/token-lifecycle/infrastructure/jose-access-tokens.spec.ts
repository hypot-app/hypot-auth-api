import { createPublicKey, type KeyObject } from 'node:crypto';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { FixedClock } from '../../shared-kernel/clock';
import type { Result } from '../../shared-kernel/result';
import type { KeyStore } from '../domain/key-store';
import { JoseAccessTokenIssuer } from './jose-access-token-issuer';
import { JoseAccessTokenVerifier } from './jose-access-token-verifier';
import { JwkSetKeyStore } from './jwk-set-key-store';
import { generateKeySet, type KeySetJson } from './signing-key-generator';

const ISSUER = 'https://auth.example.com';
const START = new Date('2026-01-01T00:00:00Z');
const START_SECONDS = START.getTime() / 1000;
const AUD = { audience: 'app_a' };

const storeOf = (set: KeySetJson): KeyStore => JwkSetKeyStore.fromJson(JSON.stringify(set));

function build(set: KeySetJson, clock = new FixedClock(START)) {
  const keyStore = storeOf(set);
  return {
    keyStore,
    clock,
    issuer: new JoseAccessTokenIssuer({ keyStore, clock, issuer: ISSUER }),
    verifier: new JoseAccessTokenVerifier({ keyStore, clock, issuer: ISSUER }),
  };
}

interface Forge {
  key: KeyObject;
  alg?: string;
  kid?: string | null;
  /** Protected header `typ`; `null` omits it. */
  typ?: string | null;
  iss?: string;
  aud?: string;
  exp?: number;
  /** Extra claim bytes, to build an otherwise valid but oversized token. */
  pad?: number;
}

/** Builds a token the issuer would never produce, to attack the verifier. */
async function forge({
  key,
  alg = 'RS256',
  kid = 'k',
  typ = 'at+jwt',
  iss = ISSUER,
  aud = 'app_a',
  exp = START_SECONDS + 3600,
  pad = 0,
}: Forge) {
  const header = { alg, ...(kid === null ? {} : { kid }), ...(typ === null ? {} : { typ }) };
  return new SignJWT(pad > 0 ? { pad: 'x'.repeat(pad) } : {})
    .setProtectedHeader(header)
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject('user-1')
    .setIssuedAt(START_SECONDS)
    .setExpirationTime(exp)
    .setJti('jti-1')
    .sign(key);
}

function expectInvalid(result: Result<unknown, { code: string; message: string }>): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('invalid_token');
    expect(result.error.message).toBe('Invalid access token');
  }
}

describe('JoseAccessTokenIssuer', () => {
  const set = generateKeySet();

  it('issues an RS256 token with kid and exactly the documented claims for one hour', async () => {
    const { issuer, keyStore } = build(set);

    const issued = await issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

    // RFC 9068: explicit typing keeps an access token from being replayed as another JWT type.
    expect(decodeProtectedHeader(issued.token)).toEqual({ alg: 'RS256', kid: keyStore.activeSigningKey().kid, typ: 'at+jwt' });
    expect(keyStore.activeSigningKey().kid).toBe(set.active.kid);
    // toEqual with a closed list also proves there is no roles or roles_globales claim.
    expect(decodeJwt(issued.token)).toEqual({
      iss: ISSUER,
      aud: 'app_a',
      sub: 'account-1',
      iat: START_SECONDS,
      exp: START_SECONDS + 3600,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(issued.expiresAt).toEqual(new Date((START_SECONDS + 3600) * 1000));
  });

  it('gives every token its own jti', async () => {
    const { issuer } = build(set);

    const [a, b] = await Promise.all([
      issuer.issue({ accountId: 'account-1', clientId: 'app_a' }),
      issuer.issue({ accountId: 'account-1', clientId: 'app_a' }),
    ]);

    expect(decodeJwt(a.token).jti).not.toBe(decodeJwt(b.token).jti);
  });
});

describe('JoseAccessTokenVerifier', () => {
  const set = generateKeySet();
  const signingKey = storeOf(set).activeSigningKey();

  it('accepts a token it issued and returns its claims', async () => {
    const { issuer, verifier } = build(set);
    const { token } = await issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

    const result = await verifier.verify(token, AUD);

    expect(result).toEqual({
      ok: true,
      value: {
        iss: ISSUER,
        aud: 'app_a',
        sub: 'account-1',
        iat: START_SECONDS,
        exp: START_SECONDS + 3600,
        jti: expect.any(String),
      },
    });
  });

  it('accepts a token for the expected audience and rejects it for another app (spec: audience mismatch)', async () => {
    const { issuer, verifier } = build(set);
    const { token } = await issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

    expect((await verifier.verify(token, { audience: 'app_a' })).ok).toBe(true);
    expectInvalid(await verifier.verify(token, { audience: 'app_b' }));
  });

  describe('audience is required (W4)', () => {
    const { verifier } = build(set);
    const tokenFor = (aud: string) => forge({ key: signingKey.privateKey, kid: signingKey.kid, aud });

    it('rejects a token issued for app A when verifying for app B', async () => {
      expectInvalid(await verifier.verify(await tokenFor('app_a'), { audience: 'app_b' }));
    });

    it('accepts a token whose audience is any entry of a non-empty expected list', async () => {
      expect((await verifier.verify(await tokenFor('app_b'), { audience: ['app_a', 'app_b'] })).ok).toBe(true);
      expectInvalid(await verifier.verify(await tokenFor('app_c'), { audience: ['app_a', 'app_b'] }));
    });

    it.each([
      ['no options', undefined],
      ['no audience', {}],
      ['an empty audience', { audience: '' }],
      ['an empty audience list', { audience: [] }],
    ])('refuses to verify with %s instead of skipping the audience check', async (_label, options) => {
      const token = await tokenFor('app_a');

      await expect(verifier.verify(token, options as never)).rejects.toThrow(TypeError);
    });
  });

  describe('explicit typing (RFC 9068, RFC 8725 3.11)', () => {
    const { verifier } = build(set);

    it('accepts a token typed at+jwt', async () => {
      const token = await forge({ key: signingKey.privateKey, kid: signingKey.kid, typ: 'at+jwt' });

      expect((await verifier.verify(token, AUD)).ok).toBe(true);
    });

    it('rejects a token without typ', async () => {
      expectInvalid(await verifier.verify(await forge({ key: signingKey.privateKey, kid: signingKey.kid, typ: null }), AUD));
    });

    it('rejects a token of another type signed by the same key (id+jwt)', async () => {
      expectInvalid(await verifier.verify(await forge({ key: signingKey.privateKey, kid: signingKey.kid, typ: 'id+jwt' }), AUD));
    });
  });

  describe('key rotation: every published key verifies by kid', () => {
    const oldKeys = generateKeySet({ next: false });
    const nextKeys = generateKeySet({ next: false });

    it.each([
      ['a retired key', { active: set.active, retired: [oldKeys.active] }, oldKeys],
      ['the pre-published next key', { active: set.active, next: nextKeys.active }, nextKeys],
    ])('accepts a token signed by %s', async (_label, verifierSet, signerSet) => {
      const signer = build(signerSet);
      const { token } = await signer.issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

      const result = await build(verifierSet as KeySetJson).verifier.verify(token, AUD);

      expect(result.ok).toBe(true);
    });

    it('rejects a token signed by a key that is no longer published', async () => {
      const { token } = await build(oldKeys).issuer.issue({ accountId: 'account-1', clientId: 'app_a' });

      expectInvalid(await build(set).verifier.verify(token, AUD));
    });
  });

  describe('rejects tokens that the issuer would never produce', () => {
    const { verifier } = build(set);
    const publicPem = createPublicKey(signingKey.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const cases: [string, () => Promise<string>][] = [
      ['a wrong issuer', () => forge({ key: signingKey.privateKey, kid: signingKey.kid, iss: 'https://evil.example' })],
      ['a tampered payload', async () => {
        const [header, , signature] = (await forge({ key: signingKey.privateKey, kid: signingKey.kid })).split('.');
        const payload = Buffer.from(JSON.stringify({ iss: ISSUER, aud: 'app_a', sub: 'admin', exp: START_SECONDS + 3600 }));
        return `${header}.${payload.toString('base64url')}.${signature}`;
      }],
      ['a kid that is not published', () => forge({ key: signingKey.privateKey, kid: 'unknown-kid' })],
      ['alg RS384 with a published key (alg pinned to RS256)', () =>
        forge({ key: signingKey.privateKey, kid: signingKey.kid, alg: 'RS384' })],
      ['alg HS256 keyed with the public key (alg confusion)', async () =>
        new SignJWT({ iss: ISSUER, aud: 'app_a', sub: 'user-1', exp: START_SECONDS + 3600 })
          .setProtectedHeader({ alg: 'HS256', kid: signingKey.kid })
          .sign(new TextEncoder().encode(publicPem))],
      ['alg none', async () => {
        const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
        return `${part({ alg: 'none', kid: signingKey.kid })}.${part({ iss: ISSUER, aud: 'app_a', sub: 'user-1', exp: START_SECONDS + 3600 })}.`;
      }],
      ['an otherwise valid token longer than the cap', () => forge({ key: signingKey.privateKey, kid: signingKey.kid, pad: 5000 })],
      ['a string that is not a JWT', async () => 'not-a-jwt'],
    ];

    it.each(cases)('%s', async (_label, makeToken) => {
      expectInvalid(await verifier.verify(await makeToken(), AUD));
    });

    it('pins RS256 itself, not only through the alg hint in the JWKS entry', async () => {
      const real = storeOf(set);
      const withoutAlgHint: KeyStore = {
        activeSigningKey: () => real.activeSigningKey(),
        publicJwks: () => ({ keys: real.publicJwks().keys.map(({ alg: _alg, ...jwk }) => jwk as never) }),
      };
      const lenient = new JoseAccessTokenVerifier({ keyStore: withoutAlgHint, clock: new FixedClock(START), issuer: ISSUER });

      expectInvalid(await lenient.verify(await forge({ key: signingKey.privateKey, kid: signingKey.kid, alg: 'RS384' }), AUD));
    });

    it('a token without kid, even when only one key is published', async () => {
      const single = build({ active: set.active });

      expectInvalid(await single.verifier.verify(await forge({ key: signingKey.privateKey, kid: null }), AUD));
    });

    it('accepts an expired token within the 5 second tolerance and rejects it after', async () => {
      const { verifier, clock } = build(set);
      const token = await forge({ key: signingKey.privateKey, kid: signingKey.kid, exp: START_SECONDS + 3600 });

      clock.advanceMs((3600 + 4) * 1000);
      expect((await verifier.verify(token, AUD)).ok).toBe(true);

      clock.advanceMs(2000);
      expectInvalid(await verifier.verify(token, AUD));
    });
  });
});
