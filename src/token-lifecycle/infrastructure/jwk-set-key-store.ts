import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { JsonWebKeySet, KeyStore, PublicJwk, SigningKey } from '../domain/key-store';

const MIN_MODULUS_BITS = 2048;

/** Thrown at startup for an unusable key set. Messages never include key material. */
export class SigningKeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyConfigError';
  }
}

const jwkSchema = z.looseObject({
  kty: z.literal('RSA'),
  n: z.string().min(1),
  e: z.string().min(1),
  kid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'must be 1-64 characters of A-Z a-z 0-9 _ -'),
});

const keySetSchema = z.object({
  active: jwkSchema,
  next: jwkSchema.optional(),
  retired: z.array(jwkSchema).optional(),
});

type Jwk = z.infer<typeof jwkSchema>;

/**
 * KeyStore adapter over a JWK set secret (ADR 8): `active` signs, `next` is
 * pre-published, `retired` keys stay verify-only during the rotation overlap (ADR 9).
 */
export class JwkSetKeyStore implements KeyStore {
  private constructor(
    private readonly active: SigningKey,
    private readonly jwks: JsonWebKeySet,
  ) {}

  static fromJson(json: string): JwkSetKeyStore {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      // The JSON.parse message quotes part of the input, so it is replaced.
      throw new SigningKeyConfigError('Invalid signing key set: not valid JSON');
    }
    const parsed = keySetSchema.safeParse(raw);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      throw new SigningKeyConfigError(`Invalid signing key set: ${problems.join('; ')}`);
    }
    const { active, next, retired = [] } = parsed.data;

    const entries = [
      { slot: 'active', jwk: active },
      ...(next ? [{ slot: 'next', jwk: next }] : []),
      ...retired.map((jwk) => ({ slot: 'retired', jwk })),
    ];
    const kids = entries.map((entry) => entry.jwk.kid);
    if (new Set(kids).size !== kids.length) {
      throw new SigningKeyConfigError('Invalid signing key set: duplicate kid');
    }

    let activeKey: KeyObject | undefined;
    const published = entries.map(({ slot, jwk }) => {
      const publicKey = toPublicKey(slot, jwk);
      // `next` is validated too: promoting an unusable key would break signing.
      if (slot !== 'retired') {
        const privateKey = toPrivateKey(slot, jwk, publicKey);
        if (slot === 'active') activeKey = privateKey;
      }
      return toPublicJwk(jwk.kid, publicKey);
    });

    return new JwkSetKeyStore(
      { kid: active.kid, alg: 'RS256', privateKey: activeKey as KeyObject },
      { keys: published },
    );
  }

  activeSigningKey(): SigningKey {
    return this.active;
  }

  publicJwks(): JsonWebKeySet {
    return this.jwks;
  }
}

function toPublicKey(slot: string, jwk: Jwk): KeyObject {
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
  } catch {
    throw new SigningKeyConfigError(`Invalid signing key set: ${slot} key is not a valid RSA key`);
  }
  if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_MODULUS_BITS) {
    throw new SigningKeyConfigError(`Invalid signing key set: ${slot} key must be at least ${MIN_MODULUS_BITS} bits`);
  }
  return publicKey;
}

/** Imports the private key and proves it matches the published public half. */
function toPrivateKey(slot: string, jwk: Jwk, publicKey: KeyObject): KeyObject {
  const invalid = new SigningKeyConfigError(`Invalid signing key set: ${slot} key is not a valid RSA private key`);
  try {
    const privateKey = createPrivateKey({ key: jwk, format: 'jwk' });
    const probe = Buffer.from('hypot-key-self-test');
    if (!verify('sha256', probe, publicKey, sign('sha256', probe, privateKey))) throw invalid;
    return privateKey;
  } catch {
    throw invalid;
  }
}

function toPublicJwk(kid: string, publicKey: KeyObject): PublicJwk {
  const { n, e } = publicKey.export({ format: 'jwk' });
  return { kty: 'RSA', n: n as string, e: e as string, kid, alg: 'RS256', use: 'sig' };
}
