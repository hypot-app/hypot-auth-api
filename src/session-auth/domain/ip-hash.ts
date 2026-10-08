import { createHash } from 'node:crypto';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';

/**
 * SHA-256 of the normalized client address, stored with a rotated refresh token so the reuse grace
 * window can tell "the same client" without keeping the address itself (ADR 35). The prefix keeps
 * this digest apart from the abuse counter keys, which hash the same address under another scope.
 */
export function hashClientIp(ip: ClientIp): Buffer {
  return createHash('sha256').update(`refresh-ip:${ip.key}`).digest();
}
