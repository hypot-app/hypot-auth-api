import { RefreshToken } from '../../domain/refresh-token';
import type { RefreshTokenRow } from './refresh-token.schema';

export const RefreshTokenMapper = {
  toDomain(row: RefreshTokenRow): RefreshToken {
    return RefreshToken.restore({
      tokenHash: row.token_hash,
      sessionId: row.session_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      replacedByHash: row.replaced_by_hash,
      consumedIpHash: row.consumed_ip_hash,
      graceUsedAt: row.grace_used_at,
      revokedAt: row.revoked_at,
    });
  },

  toPersistence(token: RefreshToken): RefreshTokenRow {
    return {
      token_hash: token.tokenHash,
      session_id: token.sessionId,
      created_at: token.createdAt,
      expires_at: token.expiresAt,
      consumed_at: token.consumedAt,
      replaced_by_hash: token.replacedByHash,
      consumed_ip_hash: token.consumedIpHash,
      grace_used_at: token.graceUsedAt,
      revoked_at: token.revokedAt,
    };
  },
};
