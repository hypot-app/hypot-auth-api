import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export interface PostResetRedirectUriOptions {
  isProduction: boolean;
}

/**
 * Fixed URL where Auth sends the user after a successful password reset (ADR 27).
 * Pure: the production rule arrives as an input, never read from config here.
 */
export class PostResetRedirectUri {
  private constructor(readonly value: string) {}

  static create(raw: string, options: PostResetRedirectUriOptions): Result<PostResetRedirectUri, DomainError> {
    const reason = rejectionReason(raw, options);
    return reason === null ? ok(new PostResetRedirectUri(raw)) : err(invalid(reason));
  }

  /** A missing value is valid and means "no redirect" (null). */
  static optional(
    raw: string | null | undefined,
    options: PostResetRedirectUriOptions,
  ): Result<PostResetRedirectUri | null, DomainError> {
    if (raw === null || raw === undefined) return ok(null);
    return PostResetRedirectUri.create(raw, options);
  }
}

function invalid(reason: string): DomainError {
  return new DomainError('invalid_post_reset_redirect_uri', `Invalid post-reset redirect URI: ${reason}`);
}

function rejectionReason(raw: string, { isProduction }: PostResetRedirectUriOptions): string | null {
  if (!URL.canParse(raw)) return 'must be an absolute URL';
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'scheme must be https';
  // Checked on the raw string: URL normalizes empty userinfo and empty fragments away.
  if (/^https?:\/\/[^/?#]*@/i.test(raw)) return 'must not contain credentials';
  if (raw.includes('#')) return 'must not contain a fragment';
  if (url.protocol === 'http:' && (isProduction || !LOCAL_HOSTS.has(url.hostname))) {
    return 'http is allowed only for localhost and 127.0.0.1 outside production';
  }
  return null;
}
