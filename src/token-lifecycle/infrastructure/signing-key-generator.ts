import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Shape of the signing key secret (`AUTH_SIGNING_KEYS` / `AUTH_SIGNING_KEYS_FILE`). */
export interface KeySetJson {
  active: Record<string, unknown>;
  next?: Record<string, unknown>;
  retired?: Record<string, unknown>[];
}

function generatePrivateJwk(): Record<string, unknown> {
  const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  // RFC 7638 thumbprint: stable, unique and safe to publish as the kid.
  const thumbprint = createHash('sha256')
    .update(JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n }))
    .digest('base64url');
  return { ...jwk, kid: thumbprint };
}

/** Generates fresh keys. Used by the dev key script and by tests; never commit the output. */
export function generateKeySet(options: { next: boolean } = { next: true }): KeySetJson {
  return options.next ? { active: generatePrivateJwk(), next: generatePrivateJwk() } : { active: generatePrivateJwk() };
}

/** Writes a new key set unless the file already exists, so reruns never rotate keys by accident. */
export function ensureKeySetFile(path: string): 'created' | 'exists' {
  if (existsSync(path)) return 'exists';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(generateKeySet(), null, 2), { mode: 0o600, flag: 'wx' });
  return 'created';
}
