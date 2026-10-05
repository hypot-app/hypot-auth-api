import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { App } from '../domain/app';
import type { AppRepository } from '../domain/app.repository';

export interface ResolveClientInput {
  clientId: string;
  /** When present, it must exactly match one of the app's registered redirect URIs. */
  redirectUri?: string;
  /**
   * The browser `Origin` header, when the request has one. It must be one of THIS app's allowed
   * origins (ADR 38). Leave it out for requests without the header (native apps, servers).
   */
  origin?: string;
}

/**
 * Looks up the active app behind a `client_id` for flows that must never
 * redirect on failure. Unknown, inactive and origin-unbound apps are indistinguishable.
 */
export class ResolveClientUseCase {
  constructor(private readonly apps: AppRepository) {}

  async execute(input: ResolveClientInput): Promise<Result<App, DomainError>> {
    const app = await this.apps.findByClientId(input.clientId);
    // One error for unknown, inactive and origin-unbound: a caller must not learn which apps exist.
    if (!app || !app.isActive() || (input.origin !== undefined && !app.allowedOrigins.includes(input.origin))) {
      return err(new DomainError('invalid_client', 'Unknown or inactive client'));
    }
    if (input.redirectUri !== undefined && !app.allowsRedirectUri(input.redirectUri)) {
      return err(new DomainError('invalid_redirect_uri', 'Redirect URI is not registered for this client'));
    }
    return ok(app);
  }
}
