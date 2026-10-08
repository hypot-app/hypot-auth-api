import type { TokenState } from './session.repository';

export interface GraceContext {
  now: Date;
  /** `hashClientIp` of the request that presents the old token. */
  ipHash: Buffer;
  /** The window in seconds; 0 disables the grace. */
  graceSeconds: number;
}

/**
 * Whether presenting an already-used token may be forgiven (ADR 35, step 1). Every condition must hold:
 * the window is on and not over (measured from the rotation), the request comes from the IP that rotated
 * it, the grace was not used before, the token was rotated and never revoked, and its session is active.
 * Pure: whether the successor is still unused is decided by the storage, atomically, afterwards.
 */
export function isGraceEligible(state: TokenState, context: GraceContext): boolean {
  const { now, ipHash, graceSeconds } = context;
  if (graceSeconds <= 0) return false;
  if (state.tokenRevokedAt !== null) return false;
  if (state.consumedAt === null || state.replacedByHash === null) return false;
  if (now.getTime() - state.consumedAt.getTime() > graceSeconds * 1000) return false;
  if (state.consumedIpHash === null || !state.consumedIpHash.equals(ipHash)) return false;
  if (state.graceUsedAt !== null) return false;
  return state.sessionRevokedAt === null && state.sessionExpiresAt > now;
}
