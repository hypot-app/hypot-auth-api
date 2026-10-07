import { anApp } from '../../../test/support/app-fixture';
import { CounterKey } from './counter-key';
import { ClientRef } from './client-ref';

const APP_A = anApp({ id: 'app-a', clientId: 'client-a' });
const APP_B = anApp({ id: 'app-b', clientId: 'client-b' });

const keyOf = (client: ClientRef) => CounterKey.of('email_ip', [client.key, '203.0.113.9']).toString('hex');

describe('ClientRef', () => {
  it('keys a resolved app by its id', () => {
    expect(keyOf(ClientRef.resolved(APP_A))).toBe(keyOf(ClientRef.resolved(APP_A)));
    expect(keyOf(ClientRef.resolved(APP_A))).not.toBe(keyOf(ClientRef.resolved(APP_B)));
  });

  it('shares one counter key across every unknown client, whatever raw client_id was sent', () => {
    const known = new Map([['client-a', APP_A]]);
    const refFor = (rawClientId: string) => {
      const app = known.get(rawClientId);
      return app === undefined ? ClientRef.unknown() : ClientRef.resolved(app);
    };

    expect(keyOf(refFor('random-1'))).toBe(keyOf(refFor('random-2')));
    expect(keyOf(refFor('random-1'))).not.toBe(keyOf(refFor('client-a')));
  });

  it('cannot be forged by an app whose id looks like the sentinel', () => {
    expect(keyOf(ClientRef.resolved(anApp({ id: 'unknown' })))).not.toBe(keyOf(ClientRef.unknown()));
  });

  it('cannot be resolved from a raw string or an unresolved look-alike (checked by npm run typecheck)', () => {
    const body = { client_id: 'attacker-chosen' };
    const misuse = () => [
      // @ts-expect-error a literal client_id is not a resolved app
      ClientRef.resolved('raw-string'),
      // @ts-expect-error a request body field is not a resolved app
      ClientRef.resolved(body.client_id),
      // @ts-expect-error a look-alike object is not an App (it has private members)
      ClientRef.resolved({ id: 'app-a', clientId: 'client-a' }),
    ];
    expect(misuse).toBeInstanceOf(Function);
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
