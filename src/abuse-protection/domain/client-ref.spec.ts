import { CounterKey } from './counter-key';
import { ClientRef } from './client-ref';

const keyOf = (client: ClientRef) => CounterKey.of('email_ip', [client.key, '203.0.113.9']).toString('hex');

describe('ClientRef', () => {
  it('keys a resolved app by its id', () => {
    expect(keyOf(ClientRef.resolved('app-a'))).toBe(keyOf(ClientRef.resolved('app-a')));
    expect(keyOf(ClientRef.resolved('app-a'))).not.toBe(keyOf(ClientRef.resolved('app-b')));
  });

  it('shares one counter key across every unknown client, whatever raw client_id was sent', () => {
    const known = new Set(['app-a']);
    const refFor = (rawClientId: string) => (known.has(rawClientId) ? ClientRef.resolved(rawClientId) : ClientRef.unknown());

    expect(keyOf(refFor('random-1'))).toBe(keyOf(refFor('random-2')));
    expect(keyOf(refFor('random-1'))).not.toBe(keyOf(refFor('app-a')));
  });

  it('cannot be forged by an app whose id looks like the sentinel', () => {
    expect(keyOf(ClientRef.resolved('unknown'))).not.toBe(keyOf(ClientRef.unknown()));
  });

  it('is only created through its factories, never from a raw string (checked by npm run typecheck)', () => {
    const accept = (client: ClientRef) => client;
    const misuse = () => [
      // @ts-expect-error a raw client_id is not a ClientRef
      accept('raw-client-id'),
      // @ts-expect-error a look-alike object is not a ClientRef either
      accept({ key: 'raw-client-id' }),
      // @ts-expect-error the constructor is private
      new ClientRef('raw-client-id'),
    ];
    expect(misuse).toBeInstanceOf(Function);
  });
});
