import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';

const MIN_CHARACTERS = 8;
/** bcrypt reads at most 72 bytes and silently ignores the rest (ADR 11). */
const MAX_BYTES = 72;

const invalidPassword = (message: string) => err(new DomainError('invalid_password', message));

/**
 * The password rules: at least 8 characters, at most 72 UTF-8 bytes, no NUL
 * (bcrypt stops reading at one). The value is returned untouched: no trimming.
 */
export function validatePassword(raw: string): Result<string, DomainError> {
  if ([...raw].length < MIN_CHARACTERS) {
    return invalidPassword(`Password must be at least ${MIN_CHARACTERS} characters`);
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
    return invalidPassword(`Password must be at most ${MAX_BYTES} bytes`);
  }
  if (raw.includes('\0')) return invalidPassword('Password must not contain NUL characters');
  return ok(raw);
}
