import { createHash, randomBytes } from 'node:crypto';

/** 256 bits of entropy (ADR 13). */
export const TOKEN_BYTES = 32;

export interface GeneratedToken {
  /** The secret value handed to the client once. Never persisted. */
  token: string;
  /** SHA-256 of `token`; the value that is stored and indexed. */
  hash: Buffer;
}

/** Port: opaque token generation (refresh tokens, one-time tokens, codes, client secrets). */
export interface TokenGenerator {
  generate(): GeneratedToken;
}

export const TOKEN_GENERATOR = Symbol('TokenGenerator');

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

export class CryptoTokenGenerator implements TokenGenerator {
  generate(): GeneratedToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: hashToken(token) };
  }
}

/**
 * Tokens come back from untrusted input (a link, a form). Anything that could not have been
 * generated here is rejected before it is hashed or looked up. A loose superset of the
 * generator's 43-character output.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}
