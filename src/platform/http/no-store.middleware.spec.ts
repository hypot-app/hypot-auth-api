import type { IncomingMessage, ServerResponse } from 'node:http';
import { noStore } from './no-store.middleware';

describe('noStore', () => {
  it('sets both cache headers and then calls next', () => {
    const headers = new Map<string, string>();
    const res = { setHeader: (name: string, value: string) => headers.set(name, value) } as unknown as ServerResponse;
    const next = jest.fn();

    noStore({} as IncomingMessage, res, next);

    expect(Object.fromEntries(headers)).toEqual({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
