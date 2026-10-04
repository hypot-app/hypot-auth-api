import { PostResetRedirectUri } from './post-reset-redirect-uri';

describe('PostResetRedirectUri', () => {
  const accepted: [string, string, boolean][] = [
    ['https url', 'https://a.example/login', false],
    ['https url in production', 'https://a.example/login', true],
    ['https with port and query', 'https://a.example:8443/login?x=1', true],
    ['http localhost outside production', 'http://localhost:3000/login', false],
    ['http 127.0.0.1 outside production', 'http://127.0.0.1:3000/login', false],
  ];

  it.each(accepted)('accepts %s', (_label, raw, isProduction) => {
    const result = PostResetRedirectUri.create(raw, { isProduction });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(raw);
  });

  const rejected: [string, string, boolean][] = [
    ['relative path', '/login', false],
    ['empty string', '', false],
    ['not a url', 'not a url', false],
    ['javascript scheme', 'javascript:alert(1)', false],
    ['ftp scheme', 'ftp://a.example/login', false],
    ['userinfo', 'https://user:pass@a.example/login', false],
    ['username only', 'https://user@a.example/login', false],
    ['fragment', 'https://a.example/login#frag', false],
    ['empty fragment', 'https://a.example/login#', false],
    ['http on a public host', 'http://a.example/login', false],
    ['http localhost lookalike', 'http://localhost.evil.example/login', false],
    ['http localhost in production', 'http://localhost:3000/login', true],
    ['http 127.0.0.1 in production', 'http://127.0.0.1:3000/login', true],
  ];

  it.each(rejected)('rejects %s', (_label, raw, isProduction) => {
    const result = PostResetRedirectUri.create(raw, { isProduction });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_post_reset_redirect_uri');
  });

  describe('optional', () => {
    it('treats null and undefined as no redirect', () => {
      expect(PostResetRedirectUri.optional(null, { isProduction: true })).toEqual({ ok: true, value: null });
      expect(PostResetRedirectUri.optional(undefined, { isProduction: true })).toEqual({ ok: true, value: null });
    });

    it('validates a present value', () => {
      const result = PostResetRedirectUri.optional('https://a.example/login', { isProduction: true });
      expect(result.ok && result.value?.value).toBe('https://a.example/login');
      expect(PostResetRedirectUri.optional('ftp://x', { isProduction: true }).ok).toBe(false);
    });
  });
});
