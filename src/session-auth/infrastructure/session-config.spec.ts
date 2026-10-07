import { loadSessionTtls, SessionConfigError } from './session-config';

describe('loadSessionTtls', () => {
  it('defaults to a 7 day idle TTL and a 30 day absolute lifetime', () => {
    expect(loadSessionTtls({})).toEqual({ idleSeconds: 604_800, absoluteSeconds: 2_592_000 });
  });

  it('reads REFRESH_IDLE_TTL_SECONDS and REFRESH_ABSOLUTE_TTL_SECONDS', () => {
    expect(loadSessionTtls({ REFRESH_IDLE_TTL_SECONDS: '60', REFRESH_ABSOLUTE_TTL_SECONDS: '3600' })).toEqual({
      idleSeconds: 60,
      absoluteSeconds: 3600,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', '', '007', '2147483648', '99999999999999999999'])('rejects %j', (value) => {
    expect(() => loadSessionTtls({ REFRESH_IDLE_TTL_SECONDS: value })).toThrow(SessionConfigError);
    expect(() => loadSessionTtls({ REFRESH_ABSOLUTE_TTL_SECONDS: value })).toThrow(SessionConfigError);
  });

  it('accepts the largest int4', () => {
    expect(loadSessionTtls({ REFRESH_IDLE_TTL_SECONDS: '2147483647' }).idleSeconds).toBe(2_147_483_647);
  });

  it('names the key but never echoes the value', () => {
    expect(() => loadSessionTtls({ REFRESH_IDLE_TTL_SECONDS: 'secret-looking' })).toThrow(/REFRESH_IDLE_TTL_SECONDS/);
    expect(() => loadSessionTtls({ REFRESH_IDLE_TTL_SECONDS: 'secret-looking' })).not.toThrow(/secret-looking/);
  });
});
