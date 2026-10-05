import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureKeySetFile, generateKeySet } from './signing-key-generator';

function thumbprint(jwk: Record<string, unknown>): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash('sha256').update(canonical).digest('base64url');
}

describe('generateKeySet', () => {
  it('creates an active and a next RSA private JWK, each with an RFC 7638 thumbprint kid', () => {
    const set = generateKeySet();

    for (const key of [set.active, set.next]) {
      expect(key).toMatchObject({ kty: 'RSA' });
      expect(typeof key?.d).toBe('string');
      expect(key?.kid).toBe(thumbprint(key as Record<string, unknown>));
      expect(createPublicKey({ key: key as never, format: 'jwk' }).asymmetricKeyDetails?.modulusLength).toBe(2048);
    }
    expect(set.next?.kid).not.toBe(set.active.kid);
    expect(set.retired).toBeUndefined();
  });

  it('can omit the next key', () => {
    expect(generateKeySet({ next: false }).next).toBeUndefined();
  });
});

describe('ensureKeySetFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hypot-keys-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a new key set when the file is missing', () => {
    const path = join(dir, 'signing-keys.json');

    expect(ensureKeySetFile(path)).toBe('created');

    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(typeof written.active.kid).toBe('string');
    expect(typeof written.next.kid).toBe('string');
  });

  it('never overwrites an existing file', () => {
    const path = join(dir, 'signing-keys.json');
    writeFileSync(path, 'existing');

    expect(ensureKeySetFile(path)).toBe('exists');
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });
});
