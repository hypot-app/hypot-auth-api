import { App } from '../../app-registry/domain/app';
import { EmailLinks } from './email-links';
import { buildEmailVariables } from './email-variables';

const links = new EmailLinks('https://auth.example.com');
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
  postResetRedirectUri: null,
  status: 'active',
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const build = (template: string, payload: Record<string, string>) =>
  buildEmailVariables({ template, payload, app, links });

describe('buildEmailVariables', () => {
  // Link formats are asserted once, in email-links.spec; here only that each template is wired to its link.
  it('confirmation: app name and the confirmation link for the token', () => {
    expect(build('confirmation', { token: TOKEN })).toEqual({
      ok: true,
      value: { appName: 'Shop', link: links.confirmation(TOKEN) },
    });
  });

  it('password-reset: link for the token and the app client_id', () => {
    expect(build('password-reset', { token: TOKEN })).toEqual({
      ok: true,
      value: { appName: 'Shop', link: links.passwordReset(TOKEN, app.clientId) },
    });
  });

  it('account-exists: forgot-password link for the client_id, no token needed', () => {
    expect(build('account-exists', {})).toEqual({
      ok: true,
      value: { appName: 'Shop', link: links.accountExists(app.clientId) },
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
