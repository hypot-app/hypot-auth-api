/**
 * The only client identity the guard accepts. A raw `client_id` from a request body is attacker
 * controlled: passing it as a key would mint a fresh counter per random id and dodge every
 * client-scoped limit. Callers must resolve the app first (`resolved`) or use the shared sentinel
 * (`unknown`), so all unknown clients share one counter per IP.
 */
export class ClientRef {
  /** Makes the class nominal: a look-alike `{ key }` object is not assignable. */
  private readonly brand = 'ClientRef';

  private constructor(readonly key: string) {}

  /** Only for the id of an app that was resolved and is active. The prefix keeps it apart from the sentinel. */
  static resolved(id: string): ClientRef {
    return new ClientRef(`app:${id}`);
  }

  static unknown(): ClientRef {
    return new ClientRef('unknown');
  }
}
