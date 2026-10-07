import type { Provider } from '@nestjs/common';
import { z } from 'zod';
import { resolvePolicies, type PolicyOverrides, type PolicyTable } from '../domain/policy';
import { SCOPES, type Scope } from '../domain/scope';

/** The raw environment this module reads, so tests can feed one without touching `process.env`. */
export const ABUSE_ENV = Symbol('AbuseEnv');
export const ABUSE_POLICIES = Symbol('AbusePolicies');

/** Thrown at startup when an `ABUSE_*` value is invalid. Never includes values. */
export class AbuseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbuseConfigError';
  }
}

const positiveInt = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer')
  .transform(Number)
  .optional();

const POLICY_FIELDS = [
  ['LIMIT', 'limit'],
  ['WINDOW_SECONDS', 'windowSeconds'],
  ['BLOCK_SECONDS', 'blockSeconds'],
] as const;

const abuseEnvKey = (scope: Scope, suffix: string): string => `ABUSE_${scope.toUpperCase()}_${suffix}`;

/** Only lockout scopes have a block length, so `_BLOCK_SECONDS` exists for them alone. */
const BLOCKING_SCOPES: readonly Scope[] = ['login_account_ip', 'login_account'];

const abuseEnvSchema = z.object(
  Object.fromEntries(
    SCOPES.flatMap((scope) =>
      POLICY_FIELDS.filter(([, field]) => field !== 'blockSeconds' || BLOCKING_SCOPES.includes(scope)).map(
        ([suffix]) => [abuseEnvKey(scope, suffix), positiveInt] as const,
      ),
    ),
  ),
);

function readPolicyOverrides(values: Record<string, unknown>): PolicyOverrides {
  const overrides: PolicyOverrides = {};
  for (const scope of SCOPES) {
    for (const [suffix, field] of POLICY_FIELDS) {
      const value = values[abuseEnvKey(scope, suffix)];
      if (typeof value === 'number') overrides[scope] = { ...overrides[scope], [field]: value };
    }
  }
  return overrides;
}

/** Parses `ABUSE_<SCOPE>_LIMIT`, `_WINDOW_SECONDS` and `_BLOCK_SECONDS` over the ADR 36 defaults. */
export function loadAbusePolicies(env: Record<string, string | undefined>): PolicyTable {
  const parsed = abuseEnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only keys and rule messages are reported.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new AbuseConfigError(`Invalid configuration: ${problems.join('; ')}`);
  }
  return resolvePolicies(readPolicyOverrides(parsed.data));
}

/** Parsed once at boot: a bad value stops the app before it listens. */
export const ABUSE_CONFIG_PROVIDERS: Provider[] = [
  { provide: ABUSE_ENV, useFactory: () => process.env },
  { provide: ABUSE_POLICIES, inject: [ABUSE_ENV], useFactory: loadAbusePolicies },
];
