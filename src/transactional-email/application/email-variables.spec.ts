import { App } from '../../app-registry/domain/app';
import { accountExistsLink, confirmationLink, passwordResetLink } from './email-links';
import { buildEmailVariables } from './email-variables';

const TOKEN = 'A'.repeat(43);

const app = App.restore({
  id: 'id-1',
  clientId: 'app_0123456789abcdef0123456789abcdef',
  name: 'Shop',
  clientType: 'public',
  clientSecretHash: null,
  redirectUris: [],
  allowedOrigins: [],
  emailFrom: null,
  emailConfirmationUrl: 'https://shop.example/confirm',
  passwordResetUrl: 'https://shop.example/reset',
  status: 'active',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const build = (template: string, payload: Record<string, string>, target: App = app) =>
  buildEmailVariables({ template, payload, app: target });

describe('buildEmailVariables', () => {
  // Link formats are asserted once, in email-links.spec; here only that each template is wired to its link.
  it('confirmation: app name and the confirmation link for the token', () => {
    expect(build('confirmation', { token: TOKEN })).toEqual({
      ok: true,
      value: { appName: 'Shop', link: confirmationLink(app, TOKEN) },
    });
  });

  it('password-reset: app name and the reset link for the token', () => {
    expect(build('password-reset', { token: TOKEN })).toEqual({
      ok: true,
      value: { appName: 'Shop', link: passwordResetLink(app, TOKEN) },
    });
  });

  it('account-exists: the reset link, no token needed', () => {
    expect(build('account-exists', {})).toEqual({
      ok: true,
      value: { appName: 'Shop', link: accountExistsLink(app) },
    });
  });

  it('welcome and password-changed: only the app name', () => {
    expect(build('welcome', {})).toEqual({ ok: true, value: { appName: 'Shop' } });
    expect(build('password-changed', {})).toEqual({ ok: true, value: { appName: 'Shop' } });
  });

  it('ignores payload fields the template does not use', () => {
    expect(build('welcome', { token: TOKEN, password: 'hunter2hunter2' })).toEqual({
      ok: true,
      value: { appName: 'Shop' },
    });
  });

  it.each([
    ['confirmation', { token: TOKEN }, 'email_confirmation_url'],
    ['password-reset', { token: TOKEN }, 'password_reset_url'],
    ['account-exists', {}, 'password_reset_url'],
  ])('%s: fails with a field-only reason when the app has no URL for it', (template, payload, field) => {
    const legacy = App.restore({ ...app, emailConfirmationUrl: null, passwordResetUrl: null });

    expect(build(template, payload, legacy)).toEqual({ ok: false, error: `app has no ${field} configured` });
  });

  it('welcome and password-changed still build for an app with no URLs', () => {
    const legacy = App.restore({ ...app, emailConfirmationUrl: null, passwordResetUrl: null });

    expect(build('welcome', {}, legacy).ok).toBe(true);
    expect(build('password-changed', {}, legacy).ok).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['too short', { token: 'abc' }],
    ['too long', { token: 'A'.repeat(257) }],
    ['outside the base64url alphabet', { token: `${'A'.repeat(42)}/` }],
  ])('rejects a token that is %s', (_label, payload) => {
    expect(build('confirmation', payload)).toEqual({ ok: false, error: 'invalid payload for template confirmation' });
    expect(build('password-reset', payload)).toEqual({ ok: false, error: 'invalid payload for template password-reset' });
  });

  it('rejects an unknown template', () => {
    expect(build('newsletter', {})).toEqual({ ok: false, error: 'unknown template' });
  });
});
