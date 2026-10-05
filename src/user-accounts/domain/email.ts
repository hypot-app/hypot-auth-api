import { DomainError } from '../../shared-kernel/domain-error';
import { isPlainMailbox } from '../../shared-kernel/mailbox';
import { err, ok, type Result } from '../../shared-kernel/result';

/** RFC 5321 limits: 254 characters in total, 64 in the local part. */
const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

const invalidEmail = () => err(new DomainError('invalid_email', 'Email address is not valid'));

/**
 * Trims, validates and lowercases an address. Accounts are unique on the lowercase
 * form (spec: per-app account uniqueness). The address ends up in mail headers, so it
 * must be one plain mailbox (no display name, list or line break).
 */
export function normalizeEmail(raw: string): Result<string, DomainError> {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !isPlainMailbox(email)) return invalidEmail();
  const [local = '', domain = ''] = email.split('@');
  if (local.length > MAX_LOCAL_PART_LENGTH || !domain.includes('.')) return invalidEmail();
  return ok(email);
}
