import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';

export type ClientType = 'public' | 'confidential';
export type AppStatus = 'active' | 'inactive';

export interface AppProps {
  id: string;
  clientId: string;
  name: string;
  clientType: ClientType;
  /** SHA-256 of the client secret. Null for public apps. */
  clientSecretHash: Buffer | null;
  redirectUris: string[];
  allowedOrigins: string[];
  emailFrom: string | null;
  /** Already validated through AppUrl when it was written. Null only for apps created before the URLs existed. */
  emailConfirmationUrl: string | null;
  passwordResetUrl: string | null;
  status: AppStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fields an operator may change. `undefined` leaves a field as is; `null` clears `emailFrom`.
 * The email link URLs can be replaced but never cleared.
 */
export interface AppChanges {
  name?: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
  emailFrom?: string | null;
  emailConfirmationUrl?: string;
  passwordResetUrl?: string;
}

/** A client application served by Auth. Plain TypeScript: no framework or persistence imports. */
export class App implements AppProps {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly clientType: ClientType;
  readonly clientSecretHash: Buffer | null;
  readonly redirectUris: string[];
  readonly allowedOrigins: string[];
  readonly emailFrom: string | null;
  readonly emailConfirmationUrl: string | null;
  readonly passwordResetUrl: string | null;
  readonly status: AppStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: AppProps) {
    this.id = props.id;
    this.clientId = props.clientId;
    this.name = props.name;
    this.clientType = props.clientType;
    this.clientSecretHash = props.clientSecretHash;
    this.redirectUris = [...props.redirectUris];
    this.allowedOrigins = [...props.allowedOrigins];
    this.emailFrom = props.emailFrom;
    this.emailConfirmationUrl = props.emailConfirmationUrl;
    this.passwordResetUrl = props.passwordResetUrl;
    this.status = props.status;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /** Builds a new app, enforcing its invariants. */
  static create(props: AppProps): Result<App, DomainError> {
    if (props.name.trim() === '') return err(invalidApp('name must not be blank'));
    if (props.clientType === 'public' && props.clientSecretHash !== null) {
      return err(invalidApp('a public app must not have a client secret'));
    }
    if (props.clientType === 'confidential' && props.clientSecretHash === null) {
      return err(invalidApp('a confidential app must have a client secret'));
    }
    const outside = urlOutsideAllowedOrigins(props);
    if (outside) return err(outside);
    return ok(new App(props));
  }

  /** Rebuilds an app that was already validated and stored. */
  static restore(props: AppProps): App {
    return new App(props);
  }

  /** Returns a changed copy; the client type and secret never change here. */
  update(changes: AppChanges, now: Date): Result<App, DomainError> {
    return App.create({
      ...this.snapshot(),
      name: changes.name ?? this.name,
      redirectUris: changes.redirectUris ?? this.redirectUris,
      allowedOrigins: changes.allowedOrigins ?? this.allowedOrigins,
      emailFrom: changes.emailFrom === undefined ? this.emailFrom : changes.emailFrom,
      emailConfirmationUrl: changes.emailConfirmationUrl ?? this.emailConfirmationUrl,
      passwordResetUrl: changes.passwordResetUrl ?? this.passwordResetUrl,
      updatedAt: now,
    });
  }

  deactivate(now: Date): App {
    return App.restore({ ...this.snapshot(), status: 'inactive', updatedAt: now });
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  private snapshot(): AppProps {
    return { ...this };
  }

  /** Exact string equality, no wildcards (spec: redirect URI validation). */
  allowsRedirectUri(uri: string): boolean {
    return this.redirectUris.includes(uri);
  }
}

/**
 * Both email link URLs must sit on one of the app's allowed origins. `update` rebuilds through `create`,
 * so changing the origins while a stored URL still uses a removed one fails here too.
 * `URL.origin` is lower-cased, like the stored (normalized) allowed origins.
 */
function urlOutsideAllowedOrigins(props: AppProps): DomainError | null {
  const links = [
    ['email_confirmation_url', props.emailConfirmationUrl],
    ['password_reset_url', props.passwordResetUrl],
  ] as const;
  for (const [field, url] of links) {
    if (url === null) continue;
    const origin = URL.canParse(url) ? new URL(url).origin : url;
    if (!props.allowedOrigins.includes(origin)) {
      return new DomainError(
        'email_url_origin_not_allowed',
        `${field} origin "${origin}" must be one of the allowed origins (--origin)`,
      );
    }
  }
  return null;
}

function invalidApp(reason: string): DomainError {
  return new DomainError('invalid_app', `Invalid app: ${reason}`);
}
