import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { generateKeySet, type KeySetJson } from './signing-key-generator';
import { FixedClock } from '../../shared-kernel/clock';
import { JwkSetKeyStore, RETIRED_KEY_RETENTION_SECONDS, SigningKeyConfigError } from './jwk-set-key-store';

const PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

describe('JwkSetKeyStore', () => {
  const set = generateKeySet();
  const [retiredSet] = [generateKeySet({ next: false })];
  const full: KeySetJson = { ...set, retired: [{ ...retiredSet.active, retiredAt: new Date().toISOString() }] };

  it('signs with the active key and exposes its kid', () => {
    const store = JwkSetKeyStore.fromJson(JSON.stringify(full));

    const key = store.activeSigningKey();
    expect(key.kid).toBe(set.active.kid);
    expect(key.alg).toBe('RS256');

    const signature = sign('sha256', Buffer.from('payload'), key.privateKey);
    const published = store.publicJwks().keys.find((jwk) => jwk.kid === key.kid);
    const publicKey = createPublicKey({ key: published as never, format: 'jwk' });
    expect(verify('sha256', Buffer.from('payload'), publicKey, signature)).toBe(true);
  });

  it('publishes active, next and retired keys in that order, as exact public JWKs', () => {
    const { keys } = JwkSetKeyStore.fromJson(JSON.stringify(full)).publicJwks();

    expect(keys.map((jwk) => jwk.kid)).toEqual([set.active.kid, set.next?.kid, retiredSet.active.kid]);
    for (const jwk of keys) {
      expect(Object.keys(jwk).sort()).toEqual(['alg', 'e', 'kid', 'kty', 'n', 'use']);
      expect(jwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    }
  });

  it('never publishes private key parameters, even when the retired entry carries them', () => {
    const serialized = JSON.stringify(JwkSetKeyStore.fromJson(JSON.stringify(full)).publicJwks());

    for (const field of PRIVATE_FIELDS) {
      expect(serialized).not.toContain(`"${field}":`);
    }
  });

  it('rotation: promoting next keeps the previous key published and signs with the new kid', () => {
    const rotated = { active: set.next, retired: [{ ...set.active, retiredAt: new Date().toISOString() }] };

    const store = JwkSetKeyStore.fromJson(JSON.stringify(rotated));

    expect(store.activeSigningKey().kid).toBe(set.next?.kid);
    expect(store.publicJwks().keys.map((jwk) => jwk.kid)).toEqual([set.next?.kid, set.active.kid]);
  });

  it('accepts a set with only the active key', () => {
    const store = JwkSetKeyStore.fromJson(JSON.stringify({ active: set.active }));
    expect(store.publicJwks().keys.map((jwk) => jwk.kid)).toEqual([set.active.kid]);
  });

  describe('retired key expiry (W3)', () => {
    const now = new Date('2026-10-04T12:00:00.000Z');
    const retiredAt = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();
    const boot = (retired: Record<string, unknown>[]) => {
      const warnings: string[] = [];
      const store = JwkSetKeyStore.fromJson(JSON.stringify({ ...set, retired }), {
        clock: new FixedClock(now),
        warn: (message) => warnings.push(message),
      });
      return { kids: store.publicJwks().keys.map((jwk) => jwk.kid), warnings };
    };
    const old = retiredSet.active;

    it('publishes a retired key until the retention window has passed', () => {
      const { kids, warnings } = boot([{ ...old, retiredAt: retiredAt(RETIRED_KEY_RETENTION_SECONDS - 1) }]);

      expect(kids).toEqual([set.active.kid, set.next?.kid, old.kid]);
      expect(warnings).toEqual([]);
    });

    it('drops a retired key at the end of the retention window and warns with the kid only', () => {
      const { kids, warnings } = boot([{ ...old, retiredAt: retiredAt(RETIRED_KEY_RETENTION_SECONDS) }]);

      expect(kids).toEqual([set.active.kid, set.next?.kid]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(old.kid);
      expect(warnings[0]).not.toContain(String(old.n));
      expect(warnings[0]).not.toContain(String(old.d));
    });

    it('keeps a retired key without retiredAt for backward compatibility but warns that it never expires', () => {
      const { kids, warnings } = boot([old]);

      expect(kids).toEqual([set.active.kid, set.next?.kid, old.kid]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(old.kid);
      expect(warnings[0]).toMatch(/no retiredAt|no expiry/);
    });

    it('keeps only the non-expired keys when several are retired', () => {
      const fresh = generateKeySet({ next: false }).active;
      const { kids } = boot([
        { ...old, retiredAt: retiredAt(RETIRED_KEY_RETENTION_SECONDS + 60) },
        { ...fresh, retiredAt: retiredAt(60) },
      ]);

      expect(kids).toEqual([set.active.kid, set.next?.kid, fresh.kid]);
    });

    it('rejects a retiredAt that is not an ISO timestamp, without echoing it', () => {
      const act = () => boot([{ ...old, retiredAt: 'SECRET-NOT-A-DATE' }]);

      expect(act).toThrow(SigningKeyConfigError);
      expect(act).toThrow('retired.0.retiredAt');
      expect(act).not.toThrow('SECRET-NOT-A-DATE');
    });
  });

  describe('rejects an invalid configuration without echoing key material', () => {
    const publicOnly = { kty: 'RSA', n: set.active.n, e: set.active.e, kid: set.active.kid };
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'jwk' });
    const { d, p, q, dp, dq, qi } = retiredSet.active;
    const mismatchedPrivate = { d, p, q, dp, dq, qi };
    const cases: [string, unknown, string][] = [
      ['a missing active key', { next: set.next }, 'active'],
      ['an active key without private parameters', { active: publicOnly }, 'active'],
      ['a non-RSA key', { active: { ...set.active, kty: 'EC' } }, 'active'],
      ['a missing kid', { active: { ...set.active, kid: undefined } }, 'kid'],
      ['an oversized kid', { active: { ...set.active, kid: 'k'.repeat(65) } }, 'kid'],
      ['a kid with unsafe characters', { active: { ...set.active, kid: 'a b/../c' } }, 'kid'],
      ['a duplicate kid', { active: set.active, next: set.active }, 'duplicate'],
      ['a private key that does not match the public key', { active: { ...set.active, ...mismatchedPrivate } }, 'valid RSA'],
      ['a key shorter than 2048 bits', { active: { ...weak, kid: 'short-key' } }, '2048'],
    ];

    it.each(cases)('%s', (_label, value, needle) => {
      const marker = String(set.active.d);
      const act = () => JwkSetKeyStore.fromJson(JSON.stringify(value));

      expect(act).toThrow(SigningKeyConfigError);
      expect(act).toThrow(needle);
      expect(act).not.toThrow(marker);
    });

    it('invalid JSON reports a static message that quotes none of the input', () => {
      const act = () => JwkSetKeyStore.fromJson('{"active": "SECRET-MARKER-123"');

      expect(act).toThrow(SigningKeyConfigError);
      expect(act).toThrow('not valid JSON');
      expect(act).not.toThrow('SECRET-MARKER-123');
    });
  });
});
