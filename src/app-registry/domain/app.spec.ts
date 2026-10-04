import { App, type AppProps } from './app';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function props(overrides: Partial<AppProps> = {}): AppProps {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    clientId: 'client-1',
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: ['https://a.example/cb'],
    allowedOrigins: ['https://a.example'],
    emailFrom: null,
    postResetRedirectUri: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('App', () => {
  it('creates a public app without a secret', () => {
    const result = App.create(props());
    expect(result.ok).toBe(true);
  });

  it('creates a confidential app with a secret hash', () => {
    const result = App.create(props({ clientType: 'confidential', clientSecretHash: Buffer.alloc(32, 1) }));
    expect(result.ok).toBe(true);
  });

  it('rejects a public app that carries a secret', () => {
    const result = App.create(props({ clientSecretHash: Buffer.alloc(32, 1) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_app');
  });

  it('rejects a confidential app without a secret', () => {
    const result = App.create(props({ clientType: 'confidential' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a blank name', () => {
    const result = App.create(props({ name: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_app');
  });

  describe('allowsRedirectUri', () => {
    const app = App.restore(props({ redirectUris: ['https://a.example/cb', 'https://a.example/cb2'] }));

    it('matches a registered URI exactly', () => {
      expect(app.allowsRedirectUri('https://a.example/cb')).toBe(true);
      expect(app.allowsRedirectUri('https://a.example/cb2')).toBe(true);
    });

    it.each([
      'https://evil.example/cb',
      'https://a.example/cb/',
      'https://a.example/CB',
      'https://a.example/cb?x=1',
      'https://a.example/*',
      'https://a.example',
      '',
    ])('rejects %p', (uri) => {
      expect(app.allowsRedirectUri(uri)).toBe(false);
    });
  });

  it('reports whether it is active', () => {
    expect(App.restore(props({ status: 'active' })).isActive()).toBe(true);
    expect(App.restore(props({ status: 'inactive' })).isActive()).toBe(false);
  });
});
