/** Port: identifiers for new apps. */
export interface IdGenerator {
  /** Internal primary key (UUID). */
  appId(): string;
  /** Public OAuth `client_id`. Not a secret, but unguessable. */
  clientId(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
