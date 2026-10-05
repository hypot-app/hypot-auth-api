import { compare, hash } from 'bcrypt';
import type { PasswordHasher } from '../domain/password-hasher';

/** bcrypt work factor (ADR 10). About 250 ms per hash on current hardware. */
export const BCRYPT_COST = 12;

/**
 * bcrypt through its async API, so hashing runs on the libuv threadpool and never
 * blocks the event loop. Inputs must already satisfy the password policy (bcrypt
 * ignores everything past 72 bytes and stops at a NUL byte).
 */
export class BcryptPasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, BCRYPT_COST);
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }
}
