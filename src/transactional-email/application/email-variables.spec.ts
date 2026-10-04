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
  it('confirmation: app name and the confirmation link built from the token', () => {
    expect(build('confirmation', { token: TOKEN })).toEqual({
      ok: true,
      value: { appName: 'Shop', link: `https://auth.example.com/api/v1/accounts/confirm?token=${TOKEN}` },
    });
  });

  it('password-reset: link carries the token and the app client_id', () => {
    expect(build('password-reset', { token: TOKEN })).toEqual({
      ok: true,
      value: {
        appName: 'Shop',
        link: `https://auth.example.com/api/v1/password/reset?token=${TOKEN}&client_id=app_0123456789abcdef0123456789abcdef`,
      },
    });
  });

  it('account-exists: forgot-password link has the client_id and no token', () => {
    expect(build('account-exists', {})).toEqual({
      ok: true,
      value: {
        appName: 'Shop',
        link: 'https://auth.example.com/api/v1/password/forgot?client_id=app_0123456789abcdef0123456789abcdef',
      },
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
