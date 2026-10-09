import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAbusePolicies } from '../../src/abuse-protection/infrastructure/abuse-config';
import { loadConfig } from '../../src/platform/config/app-config';
import { loadSessionTtls } from '../../src/session-auth/infrastructure/session-config';
import { signingKeysFromEnv } from '../../src/token-lifecycle/infrastructure/signing-keys-source';

/** Names the code reads from an environment, found by recording every property read while the loaders run. */
function variablesRead(): Set<string> {
  const read = new Set<string>();
  const env = new Proxy<Record<string, string | undefined>>({}, {
    get: (_target, key) => {
      if (typeof key === 'string') read.add(key);
      return undefined;
    },
  });
  for (const load of [loadConfig, loadAbusePolicies, loadSessionTtls, signingKeysFromEnv]) {
    try {
      load(env);
    } catch {
      // Missing required variables throw; only the names read matter here.
    }
  }
  return read;
}

const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'env-example-additions.md'), 'utf8');
const block = /```dotenv\r?\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';
const documented = new Set([...block.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]!));
/** Set by Node, not read by Auth. */
const NODE_ONLY = new Set(['UV_THREADPOOL_SIZE']);

describe('docs/env-example-additions.md', () => {
  it('lists every variable the configuration loaders read, and nothing they do not', () => {
    const read = variablesRead();

    expect([...read].filter((name) => !documented.has(name)).sort()).toEqual([]);
    expect([...documented].filter((name) => !read.has(name) && !NODE_ONLY.has(name)).sort()).toEqual([]);
    expect(read.size).toBeGreaterThan(30);
  });

  it('keeps the required lines uncommented and the optional ones commented', () => {
    const active = [...block.matchAll(/^([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);

    expect(active.sort()).toEqual(
      ['AUTH_PUBLIC_BASE_URL', 'AUTH_SIGNING_KEYS_FILE', 'DATABASE_URL', 'MAIL_FROM', 'NODE_ENV', 'PORT', 'SMTP_HOST', 'SMTP_PORT'].sort(),
    );
  });
});
