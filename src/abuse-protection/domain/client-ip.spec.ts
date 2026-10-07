import { ClientIp } from './client-ip';

describe('ClientIp', () => {
  it.each([
    ['plain IPv4', '203.0.113.9', '10.0.0.1', '203.0.113.9'],
    ['IPv4-mapped IPv6 dotted', '::ffff:203.0.113.9', undefined, '203.0.113.9'],
    ['IPv4-mapped IPv6 hex', '::ffff:cb00:7109', undefined, '203.0.113.9'],
    ['IPv6 keyed on its /64', '2001:db8:1:2:aaaa:bbbb:cccc:dddd', undefined, '2001:db8:1:2::/64'],
    ['IPv6 with a compressed run', '2001:DB8::1', undefined, '2001:db8:0:0::/64'],
    ['IPv6 with a zone id', 'fe80::1%eth0', undefined, 'fe80:0:0:0::/64'],
  ])('normalizes %s', (_label, reported, peer, key) => {
    expect(ClientIp.from(reported, peer).key).toBe(key);
  });

  it('keys two addresses of the same /64 identically and different /64s apart', () => {
    const a = ClientIp.from('2001:db8:1:2::1', undefined).key;
    expect(ClientIp.from('2001:db8:1:2:ffff::9', undefined).key).toBe(a);
    expect(ClientIp.from('2001:db8:1:3::1', undefined).key).not.toBe(a);
  });

  it.each([undefined, '', 'garbage', '1.2.3.4.5', '999.1.1.1', 'gggg::1', '1.2.3.4, 5.6.7.8'])(
    'falls back to the socket peer when the reported address is %p',
    (reported) => {
      expect(ClientIp.from(reported, '::ffff:198.51.100.7').key).toBe('198.51.100.7');
    },
  );

  it('uses the shared "unknown" key when neither address is usable', () => {
    expect(ClientIp.from('garbage', undefined).key).toBe('unknown');
    expect(ClientIp.from(undefined, 'also garbage').key).toBe('unknown');
  });
});
