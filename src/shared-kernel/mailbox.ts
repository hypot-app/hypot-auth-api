/** One plain mailbox: no display name, no list, no whitespace or control characters. */
const PLAIN_MAILBOX = /^[^\s@,;<>"()[\]\\]+@[^\s@,;<>"()[\]\\]+$/;

/**
 * True for a single bare address such as `ana@example.com`. Used wherever an address
 * ends up in a mail header or an SMTP envelope: a display name, a list or a line break
 * would let a stored value address other recipients or add headers.
 */
export function isPlainMailbox(value: string): boolean {
  return PLAIN_MAILBOX.test(value);
}
