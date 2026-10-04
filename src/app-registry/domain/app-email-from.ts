import { DomainError } from '../../shared-kernel/domain-error';
import { isPlainMailbox } from '../../shared-kernel/mailbox';
import { err, ok, type Result } from '../../shared-kernel/result';

/** Sender address an app's emails go out from. A single bare address, never a display name or a list. */
export const AppEmailFrom = {
  /** A missing value is valid and means "use MAIL_FROM" (null). */
  optional(raw: string | null | undefined): Result<string | null, DomainError> {
    if (raw === null || raw === undefined) return ok(null);
    if (isPlainMailbox(raw)) return ok(raw);
    return err(new DomainError('invalid_email_from', 'Invalid email_from: must be a single plain address like no-reply@example.com'));
  },
};
