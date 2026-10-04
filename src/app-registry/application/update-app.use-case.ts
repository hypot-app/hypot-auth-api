import type { Clock } from '../../shared-kernel/clock';
import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import type { App } from '../domain/app';
import type { AppRepository } from '../domain/app.repository';
import { AllowedOrigin } from '../domain/allowed-origin';
import { AppRedirectUri } from '../domain/app-redirect-uri';
import { PostResetRedirectUri } from '../domain/post-reset-redirect-uri';

export interface UpdateAppInput {
  clientId: string;
  name?: string;
  redirectUris?: string[];
  allowedOrigins?: string[];
  emailFrom?: string | null;
  /** `undefined` keeps the stored value, `null` clears it, a string replaces it after validation. */
  postResetRedirectUri?: string | null;
  isProduction: boolean;
}

export interface AppManagementDeps {
  apps: AppRepository;
  clock: Clock;
  uow: UnitOfWork;
}

export class UpdateAppUseCase {
  constructor(private readonly deps: AppManagementDeps) {}

  async execute(input: UpdateAppInput): Promise<Result<App, DomainError>> {
    const app = await this.deps.apps.findByClientId(input.clientId);
    if (!app) return err(new DomainError('app_not_found', `No app with client_id ${input.clientId}`));

    const rules = { isProduction: input.isProduction };

    let redirectUris: string[] | undefined;
    if (input.redirectUris !== undefined) {
      const validated = AppRedirectUri.createAll(input.redirectUris, rules);
      if (!validated.ok) return err(validated.error);
      redirectUris = validated.value.map((uri) => uri.value);
    }

    let allowedOrigins: string[] | undefined;
    if (input.allowedOrigins !== undefined) {
      const validated = AllowedOrigin.createAll(input.allowedOrigins, rules);
      if (!validated.ok) return err(validated.error);
      allowedOrigins = validated.value.map((origin) => origin.value);
    }

    let postResetRedirectUri: string | null | undefined;
    if (input.postResetRedirectUri !== undefined) {
      const validated = PostResetRedirectUri.optional(input.postResetRedirectUri, rules);
      if (!validated.ok) return err(validated.error);
      postResetRedirectUri = validated.value?.value ?? null;
    }

    const updated = app.update(
      {
        name: input.name,
        redirectUris,
        allowedOrigins,
        emailFrom: input.emailFrom,
        postResetRedirectUri,
      },
      this.deps.clock.now(),
    );
    if (!updated.ok) return err(updated.error);

    await this.deps.uow.run(() => this.deps.apps.save(updated.value));
    return ok(updated.value);
  }
}
