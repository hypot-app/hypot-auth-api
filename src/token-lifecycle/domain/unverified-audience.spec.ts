import { unverifiedAudience } from './unverified-audience';

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown): string => `${segment({ alg: 'RS256' })}.${segment(payload)}.signature`;

describe('unverifiedAudience', () => {
  it('returns a string aud claim', () => {
    expect(unverifiedAudience(jwt({ aud: 'app_shop' }))).toBe('app_shop');
  });

  it.each([
    ['no aud', { sub: 'x' }],
    ['an array aud', { aud: ['app_a', 'app_b'] }],
    ['a number aud', { aud: 7 }],
    ['an empty aud', { aud: '' }],
    ['an oversized aud', { aud: 'a'.repeat(129) }],
    ['a null payload', null],
    ['an array payload', ['app_a']],
  ])('returns null for %s', (_name, payload) => {
    expect(unverifiedAudience(jwt(payload))).toBeNull();
  });

  it.each([
    ['not a JWT', 'garbage'],
    ['two segments', 'a.b'],
    ['four segments', 'a.b.c.d'],
    ['a payload that is not JSON', `${segment({})}.${Buffer.from('not json').toString('base64url')}.sig`],
    ['an empty string', ''],
  ])('returns null for %s', (_name, token) => {
    expect(unverifiedAudience(token)).toBeNull();
  });
});
