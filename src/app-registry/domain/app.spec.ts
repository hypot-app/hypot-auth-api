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
    emailConfirmationUrl: null,
    passwordResetUrl: null,
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

describe('App changes', () => {
  const later = new Date('2026-02-02T00:00:00.000Z');

  it('update returns a new App with the changes and a bumped updatedAt, leaving the original intact', () => {
    const app = App.restore(props());
    const result = app.update({ name: 'Renamed', redirectUris: ['https://b.example/cb'] }, later);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Renamed');
    expect(result.value.redirectUris).toEqual(['https://b.example/cb']);
    expect(result.value.allowedOrigins).toEqual(['https://a.example']);
    expect(result.value.updatedAt).toEqual(later);
    expect(result.value.createdAt).toEqual(NOW);
    expect(app.name).toBe('Shop');
  });

  it('update can set and clear email_from', () => {
    const app = App.restore(props({ emailFrom: 'x@a.example' }));
    const cleared = app.update({ emailFrom: null }, later);
    expect(cleared.ok && cleared.value.emailFrom).toBeNull();

    const unchanged = app.update({}, later);
    expect(unchanged.ok && unchanged.value.emailFrom).toBe('x@a.example');
  });

  it('update replaces the email link URLs and keeps them when omitted', () => {
    const app = App.restore(
      props({
        allowedOrigins: ['https://a.example', 'https://b.example'],
        emailConfirmationUrl: 'https://a.example/confirm',
        passwordResetUrl: 'https://a.example/reset',
      }),
    );

    const changed = app.update({ emailConfirmationUrl: 'https://b.example/confirm' }, later);
    expect(changed.ok && changed.value.emailConfirmationUrl).toBe('https://b.example/confirm');
    expect(changed.ok && changed.value.passwordResetUrl).toBe('https://a.example/reset');

    const reset = app.update({ passwordResetUrl: 'https://b.example/reset' }, later);
    expect(reset.ok && reset.value.emailConfirmationUrl).toBe('https://a.example/confirm');
    expect(reset.ok && reset.value.passwordResetUrl).toBe('https://b.example/reset');
  });

  describe('email link URL origin binding', () => {
    const urls = { emailConfirmationUrl: 'https://a.example/confirm', passwordResetUrl: 'https://a.example/reset' };

    it('accepts URLs whose origin is an allowed origin, compared case-normalized and ignoring path and default port', () => {
      const result = App.create(
        props({
          allowedOrigins: ['https://a.example', 'http://localhost:5173'],
          emailConfirmationUrl: 'HTTPS://A.Example:443/confirm?x=1',
          passwordResetUrl: 'http://localhost:5173/reset',
        }),
      );
      expect(result.ok).toBe(true);
    });

    it.each([
      ['email_confirmation_url', { emailConfirmationUrl: 'https://evil.example/confirm' }],
      ['email_confirmation_url', { emailConfirmationUrl: 'https://a.example:8443/confirm' }],
    ])('rejects a %s whose origin is not allowed', (field, override) => {
      const result = App.create(props({ ...urls, ...override }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('email_url_origin_not_allowed');
        expect(result.error.message).toContain(field);
      }
    });

    it('update rejects removing an origin that a stored URL uses', () => {
      const app = App.restore(props({ ...urls, allowedOrigins: ['https://a.example', 'https://b.example'] }));
      const result = app.update({ allowedOrigins: ['https://b.example'] }, later);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('email_url_origin_not_allowed');
    });

    it('update accepts changing origins and URLs together when they stay consistent', () => {
      const app = App.restore(props(urls));
      const result = app.update(
        {
          allowedOrigins: ['https://b.example'],
          emailConfirmationUrl: 'https://b.example/confirm',
          passwordResetUrl: 'https://b.example/reset',
        },
        later,
      );
      expect(result.ok).toBe(true);
    });

    it('does not apply to a legacy app that has no URLs yet', () => {
      const result = App.restore(props({ allowedOrigins: [] })).update({ name: 'Renamed' }, later);
      expect(result.ok).toBe(true);
    });
  });

  it('update rejects a blank name', () => {
    const result = App.restore(props()).update({ name: ' ' }, later);
    expect(result.ok).toBe(false);
  });

  it('deactivate marks the app inactive and is idempotent', () => {
    const app = App.restore(props());
    const off = app.deactivate(later);
    expect(off.isActive()).toBe(false);
    expect(off.updatedAt).toEqual(later);
    expect(off.deactivate(later).isActive()).toBe(false);
    expect(app.isActive()).toBe(true);
  });
});
