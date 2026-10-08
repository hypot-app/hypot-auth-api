import type { Provider } from '@nestjs/common';
import { z } from 'zod';

/** The raw environment this module reads, so tests can feed one without touching `process.env`. */
export const SESSION_ENV = Symbol('SessionEnv');
export const SESSION_TTLS = Symbol('SessionTtls');

export interface SessionTtls {
  /** A refresh token expires after this long without use (capped at the session expiry). */
  idleSeconds: number;
  /** A session ends this long after login; rotating a token never extends it. */
  absoluteSeconds: number;
}

/** Thrown at startup when a `REFRESH_*` value is invalid. Never includes values. */
export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

const DEFAULT_IDLE_SECONDS = 604_800;
const DEFAULT_ABSOLUTE_SECONDS = 2_592_000;
/** Keeps `now + ttl` a valid date and a value Postgres can compare. */
const MAX_INT4 = 2_147_483_647;

const positiveSeconds = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer')
  .transform(Number)
  .refine((value) => value <= MAX_INT4, `must be at most ${MAX_INT4}`)
  .optional();

const sessionEnvSchema = z.object({
  REFRESH_IDLE_TTL_SECONDS: positiveSeconds,
  REFRESH_ABSOLUTE_TTL_SECONDS: positiveSeconds,
});

/** Parses `REFRESH_IDLE_TTL_SECONDS` (default 7 d) and `REFRESH_ABSOLUTE_TTL_SECONDS` (default 30 d). */
export function loadSessionTtls(env: Record<string, string | undefined>): SessionTtls {
  const parsed = sessionEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only keys and rule messages are reported.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new SessionConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  return {
    idleSeconds: parsed.data.REFRESH_IDLE_TTL_SECONDS ?? DEFAULT_IDLE_SECONDS,
    absoluteSeconds: parsed.data.REFRESH_ABSOLUTE_TTL_SECONDS ?? DEFAULT_ABSOLUTE_SECONDS,
  };
}

/** Parsed once at boot: a bad value stops the app before it listens. */
export const SESSION_CONFIG_PROVIDERS: Provider[] = [
  { provide: SESSION_ENV, useFactory: () => process.env },
  { provide: SESSION_TTLS, inject: [SESSION_ENV], useFactory: loadSessionTtls },
];
