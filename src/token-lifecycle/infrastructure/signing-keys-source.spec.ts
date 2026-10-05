import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SigningKeyConfigError } from './jwk-set-key-store';
import { signingKeysFromEnv } from './signing-keys-source';

describe('signingKeysFromEnv (ADR 20, 32)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hypot-keys-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the inline key set', () => {
    expect(signingKeysFromEnv({ AUTH_SIGNING_KEYS: '{"active":"inline"}' })).toBe('{"active":"inline"}');
  });

  it('reads the key set from a mounted file', () => {
    const file = join(dir, 'keys.json');
    writeFileSync(file, '{"active":"from-file"}');

    expect(signingKeysFromEnv({ AUTH_SIGNING_KEYS_FILE: file })).toBe('{"active":"from-file"}');
  });

  it('requires exactly one of AUTH_SIGNING_KEYS and AUTH_SIGNING_KEYS_FILE', () => {
    const both = () => signingKeysFromEnv({ AUTH_SIGNING_KEYS: '{}', AUTH_SIGNING_KEYS_FILE: join(dir, 'k.json') });
    const none = () => signingKeysFromEnv({});

    expect(both).toThrow(SigningKeyConfigError);
    expect(both).toThrow('set exactly one of AUTH_SIGNING_KEYS and AUTH_SIGNING_KEYS_FILE');
    expect(none).toThrow(SigningKeyConfigError);
    expect(none).toThrow('set exactly one of AUTH_SIGNING_KEYS and AUTH_SIGNING_KEYS_FILE');
  });

  it('treats an empty value as unset', () => {
    expect(() => signingKeysFromEnv({ AUTH_SIGNING_KEYS: '' })).toThrow('set exactly one');
  });

  it('fails fast and names only the variable when the file cannot be read', () => {
    const missing = join(dir, 'missing-secret-dir.json');
    const act = () => signingKeysFromEnv({ AUTH_SIGNING_KEYS_FILE: missing });

    expect(act).toThrow(SigningKeyConfigError);
    expect(act).toThrow('AUTH_SIGNING_KEYS_FILE: cannot read the file');
    expect(act).not.toThrow('missing-secret-dir');
  });
});
