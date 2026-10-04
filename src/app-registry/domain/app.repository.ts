import type { App } from './app';

/** Port: storage of apps. Implementations join the current unit of work. */
export interface AppRepository {
  /** Inserts a new app or updates an existing one (matched by id). */
  save(app: App): Promise<void>;
  findByClientId(clientId: string): Promise<App | null>;
}

export const APP_REPOSITORY = Symbol('AppRepository');
