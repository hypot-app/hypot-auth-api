import type { Clock } from '../../shared-kernel/clock';
import type { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { TokenGenerator } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { App, type ClientType } from '../domain/app';
import type { AppRepository } from '../domain/app.repository';
import { AllowedOrigin } from '../domain/allowed-origin';
import { AppEmailFrom } from '../domain/app-email-from';
import { AppRedirectUri } from '../domain/app-redirect-uri';
import { AppUrl } from '../domain/app-url';
import type { IdGenerator } from './id-generator';

export interface RegisterAppInput {
  name: string;
  clientType: ClientType;
  redirectUris: string[];
  allowedOrigins: string[];
  emailFrom?: string | null;
  /** Required. Where Auth's emails link to; the origin must be one of `allowedOrigins`. */
  emailConfirmationUrl: string;
  passwordResetUrl: string;
  /** From validated config, supplied by the composition root (ADR 27). */
  isProduction: boolean;
}

export interface RegisteredApp {
  app: App;
  /** Plain client secret, present only for confidential apps. Shown once, never stored. */
  clientSecret: string | null;
}

export interface RegisterAppDeps {
  apps: AppRepository;
  tokens: TokenGenerator;
  clock: Clock;
  ids: IdGenerator;
  uow: UnitOfWork;
}

export class RegisterAppUseCase {
  constructor(private readonly deps: RegisterAppDeps) {}

  async execute(input: RegisterAppInput): Promise<Result<RegisteredApp, DomainError>> {
    const rules = { isProduction: input.isProduction };
    const emailFrom = AppEmailFrom.optional(input.emailFrom);
    if (!emailFrom.ok) return err(emailFrom.error);
    const redirectUris = AppRedirectUri.createAll(input.redirectUris, rules);
    if (!redirectUris.ok) return err(redirectUris.error);
    const allowedOrigins = AllowedOrigin.createAll(input.allowedOrigins, rules);
    if (!allowedOrigins.ok) return err(allowedOrigins.error);

    const emailConfirmationUrl = AppUrl.create(input.emailConfirmationUrl, rules, 'email_confirmation_url');
    if (!emailConfirmationUrl.ok) return err(emailConfirmationUrl.error);
    const passwordResetUrl = AppUrl.create(input.passwordResetUrl, rules, 'password_reset_url');
    if (!passwordResetUrl.ok) return err(passwordResetUrl.error);

    const secret = input.clientType === 'confidential' ? this.deps.tokens.generate() : null;
    const now = this.deps.clock.now();
    const created = App.create({
      id: this.deps.ids.appId(),
      clientId: this.deps.ids.clientId(),
      name: input.name,
      clientType: input.clientType,
      clientSecretHash: secret?.hash ?? null,
      redirectUris: redirectUris.value.map((uri) => uri.value),
      allowedOrigins: allowedOrigins.value.map((origin) => origin.value),
      emailFrom: emailFrom.value,
      emailConfirmationUrl: emailConfirmationUrl.value.value,
      passwordResetUrl: passwordResetUrl.value.value,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    if (!created.ok) return err(created.error);

    await this.deps.uow.run(() => this.deps.apps.save(created.value));
    return ok({ app: created.value, clientSecret: secret?.token ?? null });
  }
}
