import { validatePassword } from './password-policy';

const messageOf = (raw: string): string | null => {
  const result = validatePassword(raw);
  return result.ok ? null : `${result.error.code}: ${result.error.message}`;
};

describe('validatePassword', () => {
  it('accepts a password of 8 characters', () => {
    expect(validatePassword('12345678')).toEqual({ ok: true, value: '12345678' });
  });

  it('rejects 7 characters', () => {
    expect(messageOf('1234567')).toBe('invalid_password: Password must be at least 8 characters');
  });

  it('counts characters, not bytes, for the minimum', () => {
    expect(validatePassword('éééééééé').ok).toBe(true); // 8 characters, 16 bytes
  });

  it('accepts exactly 72 bytes and rejects 73', () => {
    expect(validatePassword('a'.repeat(72)).ok).toBe(true);
    expect(messageOf('a'.repeat(73))).toBe('invalid_password: Password must be at most 72 bytes');
  });

  it('counts UTF-8 bytes for the maximum (conflict 6)', () => {
    expect(validatePassword('é'.repeat(36)).ok).toBe(true); // 72 bytes
    expect(messageOf('é'.repeat(37))).toBe('invalid_password: Password must be at most 72 bytes');
  });

  it('rejects a NUL character, where bcrypt would stop reading', () => {
    expect(messageOf('abcdefgh\0ijkl')).toBe('invalid_password: Password must not contain NUL characters');
  });

  it('does not trim or otherwise change the password', () => {
    expect(validatePassword('  spaced out  ')).toEqual({ ok: true, value: '  spaced out  ' });
  });
});
