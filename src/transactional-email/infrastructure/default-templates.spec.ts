import { join } from 'node:path';
import { App } from '../../app-registry/domain/app';
import { EmailLinks } from '../application/email-links';
import { buildEmailVariables } from '../application/email-variables';
import { EMAIL_TEMPLATES, type EmailTemplate } from '../domain/email-template';
import { HandlebarsTemplateRenderer } from './handlebars-template-renderer';

const BASE_URL = 'https://auth.example.com';
const CLIENT_ID = 'app_0123456789abcdef0123456789abcdef';
const TOKEN = 'Tok3n_0123456789abcdefghijklmnopqrstuvwxyzAB';
const PASSWORD = 'S3cretPassw0rd!';

const renderer = new HandlebarsTemplateRenderer(join(__dirname, '..', 'templates'));
const links = new EmailLinks(BASE_URL);

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
    emailConfirmationUrl: null,
    passwordResetUrl: null,
    status: 'active',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });

/** Renders exactly what the worker would: stored payload -> variables -> default template. */
async function renderDefault(template: EmailTemplate, appName = 'Shop') {
  // The payload carries a password a buggy caller might have put there; no template may print it.
  const payload = { token: TOKEN, password: PASSWORD, passwordHash: '$2b$12$hashhashhash' };
  const variables = buildEmailVariables({ template, payload, app: app(appName), links });
  if (!variables.ok) throw new Error(variables.error);
  return renderer.render({ template, clientId: CLIENT_ID, variables: variables.value });
}

const urlsIn = (text: string): string[] => text.match(/https?:\/\/\S+/g) ?? [];

describe('default email templates', () => {
  it.each(EMAIL_TEMPLATES)('%s: has a subject and body, and never prints a password or hash', async (template) => {
    const { subject, text } = await renderDefault(template);

    expect(subject.trim()).not.toBe('');
    expect(subject).toContain('Shop');
    expect(text).toContain('Shop');
    for (const output of [subject, text]) {
      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain('$2b$12$');
    }
  });

  it('confirmation: one link to the confirm endpoint on AUTH_PUBLIC_BASE_URL, with the token and nothing else', async () => {
    const { subject, text } = await renderDefault('confirmation');

    expect(subject).toBe('Confirm your email for Shop');
    expect(urlsIn(text)).toEqual([`${BASE_URL}/api/v1/accounts/confirm?token=${TOKEN}`]);
    expect(text).toContain('24 hours');
  });

  it('password-reset: one link to the reset page with the token and the app client_id', async () => {
    const { subject, text } = await renderDefault('password-reset');

    expect(subject).toBe('Reset your Shop password');
    expect(urlsIn(text)).toEqual([`${BASE_URL}/api/v1/password/reset?token=${TOKEN}&client_id=${CLIENT_ID}`]);
    expect(text).toContain('1 hour');
  });

  it('account-exists: links to the hosted forgot-password page for the app and carries no token', async () => {
    const { subject, text } = await renderDefault('account-exists');

    expect(subject).toBe('Sign-up attempt for your Shop account');
    expect(urlsIn(text)).toEqual([`${BASE_URL}/api/v1/password/forgot?client_id=${CLIENT_ID}`]);
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
