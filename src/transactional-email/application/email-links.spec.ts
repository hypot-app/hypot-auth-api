import { App } from '../../app-registry/domain/app';
import { accountExistsLink, confirmationLink, passwordResetLink, UnconfiguredLink } from './email-links';

const appWith = (urls: { confirm: string | null; reset: string | null }): App =>
  App.restore({
    id: 'id-1',
    clientId: 'app_0123456789abcdef0123456789abcdef',
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [],
    emailFrom: null,
    emailConfirmationUrl: urls.confirm,
    passwordResetUrl: urls.reset,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

const app = appWith({ confirm: 'https://a.example/confirm', reset: 'https://a.example/reset' });

describe('email links', () => {
  it('confirmation: the app confirmation URL with the token in the fragment', () => {
    expect(confirmationLink(app, 'tok_123')).toBe('https://a.example/confirm#token=tok_123');
  });

  it('reset: the app reset URL with the token in the fragment', () => {
    expect(passwordResetLink(app, 'tok_123')).toBe('https://a.example/reset#token=tok_123');
  });

  it('keeps an existing query string and puts the token after it, in the fragment', () => {
    const withQuery = appWith({ confirm: 'https://a.example/confirm?lang=en', reset: null });
    expect(confirmationLink(withQuery, 'tok_123')).toBe('https://a.example/confirm?lang=en#token=tok_123');
  });

  it('percent-encodes the token so it cannot add fragment parameters', () => {
    expect(confirmationLink(app, 'a&b=c#d')).toBe('https://a.example/confirm#token=a%26b%3Dc%23d');
  });

  it('account-exists: the reset URL as stored, with no token and no fragment', () => {
    const link = accountExistsLink(app);
    expect(link).toBe('https://a.example/reset');
    expect(link).not.toContain('#');
  });

  it.each([
    ['confirmation', (a: App) => confirmationLink(a, 'tok'), 'email_confirmation_url'],
    ['reset', (a: App) => passwordResetLink(a, 'tok'), 'password_reset_url'],
    ['account-exists', (a: App) => accountExistsLink(a), 'password_reset_url'],
  ])('%s: throws UnconfiguredLink naming the missing URL when the app has none', (_label, build, field) => {
    const legacy = appWith({ confirm: null, reset: null });
    expect(() => build(legacy)).toThrow(UnconfiguredLink);
    expect(() => build(legacy)).toThrow(field);
  });
});
