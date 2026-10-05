import type { App } from '../../app-registry/domain/app';
import { err, ok, type Result } from '../../shared-kernel/result';
import { isWellFormedToken } from '../../shared-kernel/token-generator';
import { isEmailTemplate, type EmailTemplate } from '../domain/email-template';
import { accountExistsLink, confirmationLink, passwordResetLink, UnconfiguredLink } from './email-links';

type Builder = (input: { payload: Readonly<Record<string, string>>; app: App }) => Record<string, string> | null;

const withToken =
  (link: (app: App, token: string) => string): Builder =>
  ({ payload, app }) => {
    const token = payload['token'];
    // The payload is read back from storage, so the token is still checked.
    if (!isWellFormedToken(token)) return null;
    return { appName: app.name, link: link(app, token) };
  };

const BUILDERS: Record<EmailTemplate, Builder> = {
  confirmation: withToken(confirmationLink),
  'password-reset': withToken(passwordResetLink),
  'account-exists': ({ app }) => ({ appName: app.name, link: accountExistsLink(app) }),
  welcome: ({ app }) => ({ appName: app.name }),
  'password-changed': ({ app }) => ({ appName: app.name }),
};

/**
 * Turns a stored payload into the variables a template renders. Only the fields
 * a template needs are read; anything else in the payload is dropped. An app without
 * the URL the email needs yields an error naming the field, never a broken link.
 */
export function buildEmailVariables(input: {
  template: string;
  payload: Readonly<Record<string, string>>;
  app: App;
}): Result<Record<string, string>, string> {
  if (!isEmailTemplate(input.template)) return err('unknown template');
  try {
    const variables = BUILDERS[input.template](input);
    return variables === null ? err(`invalid payload for template ${input.template}`) : ok(variables);
  } catch (error) {
    if (error instanceof UnconfiguredLink) return err(error.message);
    throw error;
  }
}
