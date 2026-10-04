import { createHash } from 'node:crypto';
import { CryptoTokenGenerator, hashToken } from './token-generator';

describe('CryptoTokenGenerator', () => {
  const generator = new CryptoTokenGenerator();

  it('generates a base64url token carrying at least 32 bytes of entropy', () => {
    const { token } = generator.generate();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBeGreaterThanOrEqual(32);
  });

  it('returns the SHA-256 digest of the token as the hash', () => {
    const { token, hash } = generator.generate();
    const expected = createHash('sha256').update(token).digest();
    expect(hash.equals(expected)).toBe(true);
    expect(hash).toHaveLength(32);
  });

  it('never repeats a token', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generator.generate().token));
    expect(tokens.size).toBe(50);
  });
});

describe('hashToken', () => {
  it('is deterministic for the same input', () => {
    expect(hashToken('abc').equals(hashToken('abc'))).toBe(true);
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(hashToken('abc').toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('differs for different inputs', () => {
    expect(hashToken('abc').equals(hashToken('abd'))).toBe(false);
  });
});
