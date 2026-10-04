/** Port: identifiers for new apps. */
export interface IdGenerator {
  /** Internal primary key (UUID). */
  appId(): string;
  /** Public OAuth `client_id`. Format `app_` + 32 hex chars; never starts with "-". Not a secret, but unguessable. */
  clientId(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
