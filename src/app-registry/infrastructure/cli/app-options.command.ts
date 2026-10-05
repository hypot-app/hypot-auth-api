import { CommandRunner, Option } from 'nest-commander';

/** Raised for operator mistakes; the CLI prints the message and exits with code 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface SharedAppOptions {
  name?: string;
  redirectUri?: string[];
  origin?: string[];
  emailFrom?: string;
  emailConfirmationUrl?: string;
  passwordResetUrl?: string;
}

/** Options shared by `app create` and `app update`; subclasses add their own. */
export abstract class AppOptionsCommand extends CommandRunner {
  @Option({ flags: '--name <name>', description: 'Display name of the app' })
  parseName(value: string): string {
    return value;
  }

  @Option({
    flags: '--redirect-uri <uri>',
    description: 'Registered OAuth redirect URI (repeatable; on update the given list replaces the old one)',
  })
  parseRedirectUri(value: string, previous: string[] = []): string[] {
    return [...previous, value];
  }

  @Option({
    flags: '--origin <origin>',
    description: 'Allowed CORS origin (repeatable; on update the given list replaces the old one)',
  })
  parseOrigin(value: string, previous: string[] = []): string[] {
    return [...previous, value];
  }

  @Option({ flags: '--email-from <address>', description: 'From address that overrides MAIL_FROM for this app' })
  parseEmailFrom(value: string): string {
    return value;
  }

  @Option({
    flags: '--email-confirmation-url <url>',
    description: 'App URL that confirmation emails link to (required on create; on update replaces, cannot be cleared)',
  })
  parseEmailConfirmationUrl(value: string): string {
    return value;
  }

  @Option({
    flags: '--password-reset-url <url>',
    description: 'App URL that password reset emails link to (required on create; on update replaces, cannot be cleared)',
  })
  parsePasswordResetUrl(value: string): string {
    return value;
  }
}
