import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import { LOCAL_HOSTS, type UrlRuleOptions } from './local-hosts';

/**
 * A URL on the consuming app that Auth links to from its emails (email confirmation, password reset).
 * Pure: the production rule arrives as an input, never read from config here.
 */
export class AppUrl {
  private constructor(readonly value: string) {}

  static create(raw: string, options: UrlRuleOptions): Result<AppUrl, DomainError> {
    const reason = rejectionReason(raw, options);
    return reason === null ? ok(new AppUrl(raw)) : err(invalid(reason));
  }
}

function invalid(reason: string): DomainError {
  return new DomainError('invalid_app_url', `Invalid app URL: ${reason}`);
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
