import type { App } from '../../src/app-registry/domain/app';
import type { AppRepository } from '../../src/app-registry/domain/app.repository';
import type { UnitOfWork } from '../../src/shared-kernel/unit-of-work';

/** Unit-test double for AppRepository; keeps apps by client_id. */
export class InMemoryAppRepository implements AppRepository {
  readonly apps = new Map<string, App>();

  async save(app: App): Promise<void> {
    this.apps.set(app.clientId, app);
  }

  async findByClientId(clientId: string): Promise<App | null> {
    return this.apps.get(clientId) ?? null;
  }
}

/** Unit-test double: runs the work directly, with no transaction. */
export class PassThroughUnitOfWork implements UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}
