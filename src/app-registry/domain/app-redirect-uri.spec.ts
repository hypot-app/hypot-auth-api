import { AppRedirectUri } from './app-redirect-uri';

describe('AppRedirectUri', () => {
  const accepted: [string, string, boolean][] = [
    ['https url', 'https://a.example/cb', true],
    ['https with port and query', 'https://a.example:8443/cb?x=1', true],
    ['http localhost outside production', 'http://localhost:3000/cb', false],
    ['http 127.0.0.1 outside production', 'http://127.0.0.1:3000/cb', false],
  ];

  it.each(accepted)('accepts %s and keeps it verbatim', (_label, raw, isProduction) => {
    const result = AppRedirectUri.create(raw, { isProduction });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.value).toBe(raw);
  });

  const rejected: [string, string, boolean][] = [
    ['empty string', '', false],
    ['relative path', '/cb', false],
    ['not a url', 'not a url', false],
    ['javascript scheme', 'javascript:alert(1)', false],
    ['custom scheme', 'myapp://cb', false],
    ['fragment', 'https://a.example/cb#x', false],
    ['empty fragment', 'https://a.example/cb#', false],
    ['userinfo', 'https://u:p@a.example/cb', false],
    ['http on a public host', 'http://a.example/cb', false],
    ['http localhost in production', 'http://localhost:3000/cb', true],
  ];

  it.each(rejected)('rejects %s', (_label, raw, isProduction) => {
    const result = AppRedirectUri.create(raw, { isProduction });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_redirect_uri');
  });

  it('createAll fails on the first invalid uri', () => {
    const result = AppRedirectUri.createAll(['https://a.example/cb', '/x'], { isProduction: false });
    expect(result.ok).toBe(false);
  });
});
