import { normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  User@X.Com ')).toEqual({ ok: true, value: 'user@x.com' });
  });

  it.each([
    ['no at sign', 'user.example.com'],
    ['two at signs', 'a@b@example.com'],
    ['empty local part', '@example.com'],
    ['no domain dot', 'user@localhost'],
    ['inner whitespace', 'us er@example.com'],
    ['line break (header injection)', 'a@example.com\r\nBcc: x@example.com'],
    ['a list', 'a@example.com,b@example.com'],
    ['a display name', 'Ana <a@example.com>'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    const result = normalizeEmail(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_email');
      expect(result.error.message).toBe('Email address is not valid');
    }
  });

  it('accepts 254 characters and rejects 255', () => {
    const address = (lastLabel: number) =>
      `${'a'.repeat(64)}@${['d'.repeat(63), 'd'.repeat(63), 'd'.repeat(lastLabel)].join('.')}`;
    expect(address(61)).toHaveLength(254);
    expect(normalizeEmail(address(61)).ok).toBe(true);
    expect(normalizeEmail(address(62)).ok).toBe(false);
  });

  it('rejects a local part over 64 characters', () => {
    expect(normalizeEmail(`${'a'.repeat(65)}@example.com`).ok).toBe(false);
  });
});
