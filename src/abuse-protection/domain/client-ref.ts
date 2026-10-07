import type { App } from '../../app-registry/domain/app';

/**
 * The only client identity the guard accepts. A raw `client_id` from a request body is attacker
 * controlled: passing it as a key would mint a fresh counter per random id and dodge every
 * client-scoped limit. Callers must resolve the app first (`resolved` takes the `App` that
 * `ResolveClientUseCase` returns, never a string) or use the shared sentinel (`unknown`), so all
 * unknown clients share one counter per IP.
 *
 * `App` is a type-only import: it adds no runtime dependency and no new type to maintain, and its
 * private constructor makes it nominal, so neither a string nor a look-alike object compiles. A
 * dedicated branded id would cost a second type and still need app-registry to mint it.
 */
export class ClientRef {
  /** Makes the class nominal: a look-alike `{ key }` object is not assignable. */
  private readonly brand = 'ClientRef';

  private constructor(readonly key: string) {}

  /** Only for an app that was resolved and is active. The prefix keeps it apart from the sentinel. */
  static resolved(app: App): ClientRef {
    return new ClientRef(`app:${app.id}`);
  }

  static unknown(): ClientRef {
    return new ClientRef('unknown');
  }
}
