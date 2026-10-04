import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import { LOCAL_HOSTS, type UrlRuleOptions } from './local-hosts';

/** Raw shape: scheme://host[:port] and nothing else (no userinfo, path, query, fragment or trailing slash). */
const ORIGIN_SHAPE = /^https?:\/\/[^/?#@\s*]+$/i;

/**
 * A CORS origin an app may call from. Always stored normalized (lower-case scheme and host,
 * default port dropped) so it can be matched by exact string equality against the `Origin` header.
 */
export class AllowedOrigin {
  private constructor(readonly value: string) {}

  static create(raw: string, { isProduction }: UrlRuleOptions): Result<AllowedOrigin, DomainError> {
    if (!ORIGIN_SHAPE.test(raw) || !URL.canParse(raw)) {
      return err(invalid(raw, 'must be an origin only: https://host[:port], without path, query, fragment or wildcard'));
    }
    const url = new URL(raw);
    if (url.protocol === 'http:' && (isProduction || !LOCAL_HOSTS.has(url.hostname))) {
      return err(invalid(raw, 'http is allowed only for localhost and 127.0.0.1 outside production'));
    }
    return ok(new AllowedOrigin(url.origin));
  }

  /** Validates every origin, normalizes them and drops duplicates. Fails on the first invalid one. */
  static createAll(raws: readonly string[], options: UrlRuleOptions): Result<AllowedOrigin[], DomainError> {
    const byValue = new Map<string, AllowedOrigin>();
    for (const raw of raws) {
      const origin = AllowedOrigin.create(raw, options);
      if (!origin.ok) return err(origin.error);
      byValue.set(origin.value.value, origin.value);
    }
    return ok([...byValue.values()]);
  }
}

function invalid(raw: string, reason: string): DomainError {
  return new DomainError('invalid_allowed_origin', `Invalid allowed origin "${raw}": ${reason}`);
}
