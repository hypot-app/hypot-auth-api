import type { App } from './app';

/** Port: storage of apps. Implementations join the current unit of work. */
export interface AppRepository {
  /** Inserts a new app or updates an existing one (matched by id). */
  save(app: App): Promise<void>;
  findByClientId(clientId: string): Promise<App | null>;
  /** True when an active app lists exactly this origin in `allowed_origins`. */
  isOriginAllowed(origin: string): Promise<boolean>;
}

export const APP_REPOSITORY = Symbol('AppRepository');
