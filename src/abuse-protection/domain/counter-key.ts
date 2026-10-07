import { createHash } from 'node:crypto';
import type { Scope } from './scope';

export const CounterKey = {
  /**
   * SHA-256 of the scope and its parts. Each part is length-prefixed, so
   * `['ab', 'c']` and `['a', 'bc']` differ, and the scope is part of the digest
   * so the same IP under two scopes never shares a row. Parts are lowercased and
   * trimmed: this only merges buckets, which makes limits stricter, never looser.
   */
  of(scope: Scope, parts: readonly string[]): Buffer {
    const hash = createHash('sha256').update(`${scope.length}:${scope}`);
    for (const part of parts) {
      const normalized = part.trim().toLowerCase();
      hash.update(`${normalized.length}:${normalized}`);
    }
    return hash.digest();
  },
};
