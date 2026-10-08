import { Session } from '../../domain/session';
import type { SessionRow } from './session.schema';

export const SessionMapper = {
  toDomain(row: SessionRow): Session {
    return Session.restore({
      id: row.id,
      appId: row.app_id,
      userId: row.user_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokedReason: row.revoked_reason,
    });
  },

  toPersistence(session: Session): SessionRow {
    return {
      id: session.id,
      app_id: session.appId,
      user_id: session.userId,
      created_at: session.createdAt,
      last_used_at: session.lastUsedAt,
      expires_at: session.expiresAt,
      revoked_at: session.revokedAt,
      revoked_reason: session.revokedReason,
    };
  },
};
