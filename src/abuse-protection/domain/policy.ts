import type { Scope } from './scope';

export interface Policy {
  /** Hits allowed per window. */
  limit: number;
  windowSeconds: number;
  /** Lockout length once `limit` is reached; null for plain per-window limits. */
  blockSeconds: number | null;
}

export type PolicyTable = Record<Scope, Policy>;

/** ADR 36 defaults. */
export const DEFAULT_POLICIES: PolicyTable = {
  login_ip: { limit: 100, windowSeconds: 900, blockSeconds: null },
  login_account_ip: { limit: 5, windowSeconds: 900, blockSeconds: 900 },
  login_account: { limit: 50, windowSeconds: 3600, blockSeconds: 900 },
  email_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
  reset_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
  confirm_ip: { limit: 20, windowSeconds: 3600, blockSeconds: null },
  refresh_ip: { limit: 60, windowSeconds: 900, blockSeconds: null },
  email_account: { limit: 3, windowSeconds: 3600, blockSeconds: null },
};

export type PolicyOverrides = Partial<Record<Scope, Partial<Policy>>>;

export function resolvePolicies(overrides: PolicyOverrides): PolicyTable {
  const resolved = { ...DEFAULT_POLICIES };
  for (const scope of Object.keys(overrides) as Scope[]) {
    resolved[scope] = { ...DEFAULT_POLICIES[scope], ...overrides[scope] };
  }
  return resolved;
}
