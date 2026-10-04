import { isPlainMailbox } from './mailbox';

describe('isPlainMailbox', () => {
  it.each(['ana@example.com', 'no-reply@auth.example', 'first.last+tag@mail.example.org'])('accepts %s', (value) => {
    expect(isPlainMailbox(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['no @', 'ana.example.com'],
    ['two @', 'a@b@example.com'],
    ['a display name', 'Ana <ana@example.com>'],
    ['a quoted display name', '"Ana" ana@example.com'],
    ['a list', 'a@example.com, b@example.com'],
    ['a semicolon list', 'a@example.com;b@example.com'],
    ['CRLF header injection', 'a@example.com\r\nBcc: x@example.com'],
    ['a trailing newline', 'a@example.com\n'],
    ['whitespace', 'a b@example.com'],
  ])('rejects %s', (_label, value) => {
    expect(isPlainMailbox(value)).toBe(false);
  });
});
