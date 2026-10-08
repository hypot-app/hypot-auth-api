import { ClientIp } from '../../abuse-protection/domain/client-ip';
import { hashClientIp } from './ip-hash';

describe('hashClientIp', () => {
  it('is a 32-byte SHA-256 digest that does not contain the address', () => {
    const hash = hashClientIp(ClientIp.from('203.0.113.9', undefined));

    expect(hash).toHaveLength(32);
    expect(hash.toString('utf8')).not.toContain('203.0.113.9');
  });

  it('is stable for one address and differs between addresses', () => {
    const a = ClientIp.from('203.0.113.9', undefined);

    expect(hashClientIp(a)).toEqual(hashClientIp(ClientIp.from('203.0.113.9', undefined)));
    expect(hashClientIp(a)).not.toEqual(hashClientIp(ClientIp.from('203.0.113.10', undefined)));
  });

  it('treats addresses in the same IPv6 /64 as one client', () => {
    const first = ClientIp.from('2001:db8:1:2::1', undefined);
    const second = ClientIp.from('2001:db8:1:2:ffff:ffff:ffff:ffff', undefined);
    const otherPrefix = ClientIp.from('2001:db8:1:3::1', undefined);

    expect(hashClientIp(first)).toEqual(hashClientIp(second));
    expect(hashClientIp(first)).not.toEqual(hashClientIp(otherPrefix));
  });
});
