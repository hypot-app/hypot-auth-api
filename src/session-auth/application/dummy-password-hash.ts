import { randomBytes } from 'node:crypto';
import type { PasswordHasher } from '../../user-accounts/domain/password-hasher';

export const DUMMY_PASSWORD_HASH = Symbol('DummyPasswordHash');

/**
 * A hash of a random secret nobody knows, made with the real hasher so it has the real cost. Login
 * compares against it when there is no usable account, so an unknown email takes as long as a known one.
 */
export function createDummyPasswordHash(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomBytes(24).toString('hex'));
}
