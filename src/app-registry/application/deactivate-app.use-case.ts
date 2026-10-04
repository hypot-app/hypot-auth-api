import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { App } from '../domain/app';
import type { AppManagementDeps } from './update-app.use-case';

export class DeactivateAppUseCase {
  constructor(private readonly deps: AppManagementDeps) {}

  async execute(input: { clientId: string }): Promise<Result<App, DomainError>> {
    const app = await this.deps.apps.findByClientId(input.clientId);
    if (!app) return err(new DomainError('app_not_found', `No app with client_id ${input.clientId}`));

    const deactivated = app.deactivate(this.deps.clock.now());
    await this.deps.uow.run(() => this.deps.apps.save(deactivated));
    return ok(deactivated);
  }
}
