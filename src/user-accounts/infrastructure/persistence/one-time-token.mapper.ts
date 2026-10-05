import { OneTimeToken } from '../../domain/one-time-token';
import type { OneTimeTokenRow } from './one-time-token.schema';

export const OneTimeTokenMapper = {
  toDomain(row: OneTimeTokenRow): OneTimeToken {
    return OneTimeToken.restore({
      id: row.id,
      userId: row.user_id,
      purpose: row.purpose,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    });
  },

  toPersistence(token: OneTimeToken): OneTimeTokenRow {
    return {
      id: token.id,
      user_id: token.userId,
      purpose: token.purpose,
      token_hash: token.tokenHash,
      expires_at: token.expiresAt,
      consumed_at: token.consumedAt,
    };
  },
};
