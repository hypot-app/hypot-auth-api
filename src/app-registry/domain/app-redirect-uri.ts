import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import { LOCAL_HOSTS, type UrlRuleOptions } from './local-hosts';

/**
 * An OAuth redirect URI registered for an app. Kept verbatim: matching at authorization time is
 * exact string equality, so it must not be rewritten here.
 */
export class AppRedirectUri {
  private constructor(readonly value: string) {}

  static create(raw: string, options: UrlRuleOptions): Result<AppRedirectUri, DomainError> {
    const reason = rejectionReason(raw, options);
    return reason === null ? ok(new AppRedirectUri(raw)) : err(invalid(raw, reason));
  }

  /** Validates every URI. Fails on the first invalid one. */
  static createAll(raws: readonly string[], options: UrlRuleOptions): Result<AppRedirectUri[], DomainError> {
    const created: AppRedirectUri[] = [];
    for (const raw of raws) {
      const uri = AppRedirectUri.create(raw, options);
      if (!uri.ok) return err(uri.error);
      created.push(uri.value);
    }
    return ok(created);
  }
}

function invalid(raw: string, reason: string): DomainError {
  return new DomainError('invalid_redirect_uri', `Invalid redirect URI "${raw}": ${reason}`);
}

function rejectionReason(raw: string, { isProduction }: UrlRuleOptions): string | null {
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
