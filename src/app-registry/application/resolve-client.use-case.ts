import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { App } from '../domain/app';
import type { AppRepository } from '../domain/app.repository';

export interface ResolveClientInput {
  clientId: string;
  /** When present, it must exactly match one of the app's registered redirect URIs. */
  redirectUri?: string;
}

/**
 * Looks up the active app behind a `client_id` for flows that must never
 * redirect on failure. Unknown and inactive apps are indistinguishable.
 */
export class ResolveClientUseCase {
  constructor(private readonly apps: AppRepository) {}

  async execute(input: ResolveClientInput): Promise<Result<App, DomainError>> {
    const app = await this.apps.findByClientId(input.clientId);
    if (!app || !app.isActive()) {
      return err(new DomainError('invalid_client', 'Unknown or inactive client'));
    }
    if (input.redirectUri !== undefined && !app.allowsRedirectUri(input.redirectUri)) {
      return err(new DomainError('invalid_redirect_uri', 'Redirect URI is not registered for this client'));
    }
    return ok(app);
  }
}
