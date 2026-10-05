import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { SystemClock, type Clock } from '../../shared-kernel/clock';
import type { JsonWebKeySet, KeyStore, PublicJwk, SigningKey } from '../domain/key-store';

const MIN_MODULUS_BITS = 2048;

/**
 * How long a retired key stays published after `retiredAt` (ADR 32): the 1 hour access
 * token lifetime, plus the 5 second clock tolerance, plus the 10 minute default cache of
 * jose's remote JWKS (it ignores Cache-Control, so it is the longest cache a consumer has).
 */
export const RETIRED_KEY_RETENTION_SECONDS = 3600 + 5 + 600;

export interface KeyStoreOptions {
  clock?: Clock;
  /** Receives boot warnings. They name a `kid` only, never key material. */
  warn?: (message: string) => void;
}

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
  // `retiredAt`: when the key stopped signing. Without it a retired key never expires.
  retired: z.array(jwkSchema.extend({ retiredAt: z.iso.datetime({ offset: true }).optional() })).optional(),
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

  static fromJson(json: string, options: KeyStoreOptions = {}): JwkSetKeyStore {
    const clock = options.clock ?? new SystemClock();
    const warn = options.warn ?? ((message: string) => new Logger(JwkSetKeyStore.name).warn(message));
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

    const allKids = [active, ...(next ? [next] : []), ...retired].map((jwk) => jwk.kid);
    if (new Set(allKids).size !== allKids.length) {
      throw new SigningKeyConfigError('Invalid signing key set: duplicate kid');
    }

    const stillPublished = retired.filter((jwk) => {
      if (jwk.retiredAt === undefined) {
        warn(`Retired signing key ${jwk.kid} has no retiredAt and never expires; add retiredAt to let it expire`);
        return true;
      }
      const expiresAt = Date.parse(jwk.retiredAt) + RETIRED_KEY_RETENTION_SECONDS * 1000;
      if (clock.now().getTime() < expiresAt) return true;
      warn(`Retired signing key ${jwk.kid} is past its retention window and is no longer published; remove it from the key set`);
      return false;
    });

    const entries = [
      { slot: 'active', jwk: active },
      ...(next ? [{ slot: 'next', jwk: next }] : []),
      ...stillPublished.map((jwk) => ({ slot: 'retired', jwk })),
    ];

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
