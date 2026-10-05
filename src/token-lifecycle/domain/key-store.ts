import type { KeyObject } from 'node:crypto';

/** The key used to sign new access tokens. */
export interface SigningKey {
  kid: string;
  alg: 'RS256';
  privateKey: KeyObject;
}

/** A public RSA key as published in JWKS. Never carries private parameters. */
export interface PublicJwk {
  kty: 'RSA';
  n: string;
  e: string;
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

export interface JsonWebKeySet {
  keys: PublicJwk[];
}

/**
 * Port: where signing keys come from. `publicJwks()` lists every key a consumer
 * may need to verify a live token: the active key, the pre-published `next` key
 * and the retired keys still inside the rotation overlap (ADR 9).
 */
export interface KeyStore {
  activeSigningKey(): SigningKey;
  publicJwks(): JsonWebKeySet;
}

export const KEY_STORE = Symbol('KeyStore');
