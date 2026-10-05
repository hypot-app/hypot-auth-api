import { readFileSync } from 'node:fs';
import { SigningKeyConfigError } from './jwk-set-key-store';

/** Where the signing key secret comes from. Called once, at boot, by the key store factory. */
export type SigningKeysSource = () => string;

export const SIGNING_KEYS_SOURCE = Symbol('SigningKeysSource');

/**
 * Reads the key set JSON secret from `AUTH_SIGNING_KEYS` (inline) or
 * `AUTH_SIGNING_KEYS_FILE` (mounted file); exactly one must be set (ADR 20, 32).
 * It lives here, not in `loadConfig`, so processes that never sign (the operator CLI)
 * do not need the keys, and so the raw secret is not retained in `AppConfig`.
 * Errors name variables only, never values or paths.
 */
export function signingKeysFromEnv(env: Record<string, string | undefined>): string {
  const inline = env.AUTH_SIGNING_KEYS || undefined;
  const file = env.AUTH_SIGNING_KEYS_FILE || undefined;
  if ((inline === undefined) === (file === undefined)) {
    throw new SigningKeyConfigError(
      'Invalid signing key configuration: set exactly one of AUTH_SIGNING_KEYS and AUTH_SIGNING_KEYS_FILE',
    );
  }
  if (inline !== undefined) return inline;
  try {
    return readFileSync(file as string, 'utf8');
  } catch {
    // The OS error can echo the path; only the variable name is reported.
    throw new SigningKeyConfigError('Invalid signing key configuration: AUTH_SIGNING_KEYS_FILE: cannot read the file');
  }
}
