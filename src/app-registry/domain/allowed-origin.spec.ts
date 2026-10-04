import { AllowedOrigin } from './allowed-origin';

describe('AllowedOrigin', () => {
  const accepted: [string, string, string, boolean][] = [
    ['https origin', 'https://a.example', 'https://a.example', true],
    ['https with port', 'https://a.example:8443', 'https://a.example:8443', true],
    ['upper-case scheme and host are lower-cased', 'HTTPS://App.Example.COM', 'https://app.example.com', true],
    ['default port is dropped', 'https://a.example:443', 'https://a.example', true],
    ['http localhost outside production', 'http://localhost:3000', 'http://localhost:3000', false],
    ['http 127.0.0.1 outside production', 'http://127.0.0.1:5173', 'http://127.0.0.1:5173', false],
    ['https localhost in production', 'https://localhost:3000', 'https://localhost:3000', true],
  ];

  it.each(accepted)('accepts %s', (_label, raw, normalized, isProduction) => {
    const result = AllowedOrigin.create(raw, { isProduction });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(normalized);
  });

  const rejected: [string, string, boolean][] = [
    ['empty string', '', false],
    ['the "null" origin', 'null', false],
    ['a wildcard', '*', false],
    ['a wildcard subdomain', 'https://*.a.example', false],
    ['no scheme', 'a.example', false],
    ['a non-http scheme', 'ftp://a.example', false],
    ['a javascript scheme', 'javascript:alert(1)', false],
    ['a trailing slash', 'https://a.example/', false],
    ['a path', 'https://a.example/app', false],
    ['a query', 'https://a.example?x=1', false],
    ['a fragment', 'https://a.example#x', false],
    ['userinfo', 'https://u:p@a.example', false],
    ['http on a public host', 'http://a.example', false],
    ['http localhost lookalike', 'http://localhost.evil.example', false],
    ['http localhost in production', 'http://localhost:3000', true],
    ['surrounding whitespace', ' https://a.example', false],
  ];

  it.each(rejected)('rejects %s', (_label, raw, isProduction) => {
    const result = AllowedOrigin.create(raw, { isProduction });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_allowed_origin');
  });

  it('createAll normalizes every origin and de-duplicates', () => {
    const result = AllowedOrigin.createAll(['https://A.example', 'https://a.example'], { isProduction: false });
    expect(result.ok && result.value.map((o) => o.value)).toEqual(['https://a.example']);
  });

  it('createAll fails on the first invalid origin', () => {
    const result = AllowedOrigin.createAll(['https://a.example', '*'], { isProduction: false });
    expect(result.ok).toBe(false);
  });
});
