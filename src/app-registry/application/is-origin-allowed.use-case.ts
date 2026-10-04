import type { Clock } from '../../shared-kernel/clock';
import type { AppRepository } from '../domain/app.repository';

export interface IsOriginAllowedDeps {
  apps: AppRepository;
  clock: Clock;
  /** How long an answer is reused before the database is asked again. */
  ttlMs: number;
  /** Upper bound of cached origins; the cache is dropped when it is reached (origins come from untrusted requests). */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 1000;

/**
 * CORS allowlist: is this `Origin` registered by any active app?
 * Answers are cached per origin for a short TTL, so a deactivated app or removed origin
 * can still be accepted for up to `ttlMs`.
 */
export class IsOriginAllowedUseCase {
  private readonly cache = new Map<string, { allowed: boolean; expiresAt: number }>();

  constructor(private readonly deps: IsOriginAllowedDeps) {}

  async execute(origin: string): Promise<boolean> {
    const now = this.deps.clock.now().getTime();
    const cached = this.cache.get(origin);
    if (cached !== undefined && cached.expiresAt > now) return cached.allowed;

    const allowed = await this.deps.apps.isOriginAllowed(origin);
    if (this.cache.size >= (this.deps.maxEntries ?? DEFAULT_MAX_ENTRIES)) this.cache.clear();
    this.cache.set(origin, { allowed, expiresAt: now + this.deps.ttlMs });
    return allowed;
  }
}
