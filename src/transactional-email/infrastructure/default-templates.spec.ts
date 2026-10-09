import { join } from 'node:path';
import { App } from '../../app-registry/domain/app';
import { TOKEN_TTL_HOURS } from '../../user-accounts/domain/one-time-token';
import { buildEmailVariables } from '../application/email-variables';
import { EMAIL_TEMPLATES, type EmailTemplate } from '../domain/email-template';
import { HandlebarsTemplateRenderer } from './handlebars-template-renderer';

const CONFIRM_URL = 'https://shop.example/confirm';
const RESET_URL = 'https://shop.example/reset';
const AUTH_BASE_URL = 'https://auth.example.com';
const CLIENT_ID = 'app_0123456789abcdef0123456789abcdef';
const TOKEN = 'Tok3n_0123456789abcdefghijklmnopqrstuvwxyzAB';
const PASSWORD = 'S3cretPassw0rd!';

const renderer = new HandlebarsTemplateRenderer(join(__dirname, '..', 'templates'));

const app = (name: string) =>
  App.restore({
    id: 'id-1',
    clientId: CLIENT_ID,
    name,
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [],
    emailFrom: null,
    emailConfirmationUrl: CONFIRM_URL,
    passwordResetUrl: RESET_URL,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

/** Renders exactly what the worker would: stored payload -> variables -> default template. */
async function renderDefault(template: EmailTemplate, appName = 'Shop') {
  // The payload carries a password a buggy caller might have put there; no template may print it.
  const payload = { token: TOKEN, password: PASSWORD, passwordHash: '$2b$12$hashhashhash' };
  const variables = buildEmailVariables({ template, payload, app: app(appName) });
  if (!variables.ok) throw new Error(variables.error);
  return renderer.render({ template, clientId: CLIENT_ID, variables: variables.value });
}

/** "1 hour", "24 hours": the wording the templates must use for a token that works this many hours. */
const hours = (count: number): string => `${count} ${count === 1 ? 'hour' : 'hours'}`;

const urlsIn = (text: string): string[] => text.match(/https?:\/\/\S+/g) ?? [];

describe('default email templates', () => {
  it.each(EMAIL_TEMPLATES)('%s: has a subject and body, and never prints a password or hash', async (template) => {
    const { subject, text } = await renderDefault(template);

    expect(subject.trim()).not.toBe('');
    expect(subject).toContain('Shop');
    expect(text).toContain('Shop');
    for (const output of [subject, text]) {
      expect(output).not.toContain(AUTH_BASE_URL);
      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain('$2b$12$');
    }
  });

  it('confirmation: one link: the app confirmation URL with the token in the fragment', async () => {
    const { subject, text } = await renderDefault('confirmation');

    expect(subject).toBe('Confirm your email for Shop');
    expect(urlsIn(text)).toEqual([`${CONFIRM_URL}#token=${TOKEN}`]);
    expect(text).toContain(`valid for ${hours(TOKEN_TTL_HOURS.email_verification)}:`);
  });

  it('password-reset: one link: the app reset URL with the token in the fragment', async () => {
    const { subject, text } = await renderDefault('password-reset');

    expect(subject).toBe('Reset your Shop password');
    expect(urlsIn(text)).toEqual([`${RESET_URL}#token=${TOKEN}`]);
    expect(text).toContain(`valid for ${hours(TOKEN_TTL_HOURS.password_reset)}:`);
  });

  it('account-exists: links to the app reset URL with no fragment and carries no token', async () => {
    const { subject, text } = await renderDefault('account-exists');

    expect(subject).toBe('Sign-up attempt for your Shop account');
    expect(urlsIn(text)).toEqual([RESET_URL]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain('token');
    expect(text).toMatch(/someone tried to create/i);
    expect(text).toMatch(/sign in/i);
  });

  it.each(['welcome', 'password-changed'] as const)('%s: informational, no links', async (template) => {
    expect(urlsIn((await renderDefault(template)).text)).toEqual([]);
  });

  it('keeps an app name with special characters readable in the plain text', async () => {
    const { subject, text } = await renderDefault('welcome', `Tom & Jerry's <Shop>`);

    expect(subject).toBe(`Welcome to Tom & Jerry's <Shop>`);
    expect(text).toContain(`Tom & Jerry's <Shop>`);
  });
});
