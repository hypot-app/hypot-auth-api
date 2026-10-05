import type { App } from '../../app-registry/domain/app';

/**
 * The app has no URL for the link an email needs (an app created before the URLs existed).
 * The message names the field only: no token, address or link.
 */
export class UnconfiguredLink extends Error {
  constructor(field: 'email_confirmation_url' | 'password_reset_url') {
    super(`app has no ${field} configured`);
    this.name = 'UnconfiguredLink';
  }
}

/**
 * Links in emails point at the app's own screens (ADR 39), never at Auth. The stored URL
 * was validated by AppUrl (absolute, no fragment), so the single-use token goes in the
 * fragment: it never reaches a server, a log or a Referer header. The token is
 * percent-encoded as a precaution; it is base64url already.
 */
export function confirmationLink(app: App, token: string): string {
  return withToken(requireUrl(app.emailConfirmationUrl, 'email_confirmation_url'), token);
}

export function passwordResetLink(app: App, token: string): string {
  return withToken(requireUrl(app.passwordResetUrl, 'password_reset_url'), token);
}

/** Points to the app's reset screen with no token and no fragment. */
export function accountExistsLink(app: App): string {
  return requireUrl(app.passwordResetUrl, 'password_reset_url');
}

const withToken = (url: string, token: string): string => `${url}#token=${encodeURIComponent(token)}`;

function requireUrl(url: string | null, field: ConstructorParameters<typeof UnconfiguredLink>[0]): string {
  if (url === null) throw new UnconfiguredLink(field);
  return url;
}
