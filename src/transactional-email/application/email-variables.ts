import type { App } from '../../app-registry/domain/app';
import { err, ok, type Result } from '../../shared-kernel/result';
import { isEmailTemplate, type EmailTemplate } from '../domain/email-template';
import type { EmailLinks } from './email-links';

/** Tokens come from TokenGenerator (base64url). The payload is read back from storage, so it is still checked. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

type Builder = (input: { payload: Readonly<Record<string, string>>; app: App; links: EmailLinks }) => Record<string, string> | null;

const withToken =
  (link: (links: EmailLinks, token: string, app: App) => string): Builder =>
  ({ payload, app, links }) => {
    const token = payload['token'];
    if (token === undefined || !TOKEN_PATTERN.test(token)) return null;
    return { appName: app.name, link: link(links, token, app) };
  };

const BUILDERS: Record<EmailTemplate, Builder> = {
  confirmation: withToken((links, token) => links.confirmation(token)),
  'password-reset': withToken((links, token, app) => links.passwordReset(token, app.clientId)),
  'account-exists': ({ app, links }) => ({ appName: app.name, link: links.accountExists(app.clientId) }),
  welcome: ({ app }) => ({ appName: app.name }),
  'password-changed': ({ app }) => ({ appName: app.name }),
};

/**
 * Turns a stored payload into the variables a template renders. Only the fields
 * a template needs are read; anything else in the payload is dropped.
 */
export function buildEmailVariables(input: {
  template: string;
  payload: Readonly<Record<string, string>>;
  app: App;
  links: EmailLinks;
}): Result<Record<string, string>, string> {
  if (!isEmailTemplate(input.template)) return err('unknown template');
  const variables = BUILDERS[input.template](input);
  return variables === null ? err(`invalid payload for template ${input.template}`) : ok(variables);
}
