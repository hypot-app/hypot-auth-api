import { EntitySchema } from 'typeorm';
import { SESSION_REVOKED_REASONS, type SessionRevokedReason } from '../../domain/session';

/** Persistence shape of a session. Lives in infrastructure only; the domain never sees it. */
export interface SessionRow {
  id: string;
  app_id: string;
  user_id: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: SessionRevokedReason | null;
}

export const SessionSchema = new EntitySchema<SessionRow>({
  name: 'AuthSession',
  tableName: 'auth_sessions',
  columns: {
    id: { type: 'uuid', primary: true },
    app_id: { type: 'uuid' },
    user_id: { type: 'uuid' },
    created_at: { type: 'timestamptz' },
    last_used_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz', nullable: true },
    revoked_reason: {
      type: 'enum',
      enum: [...SESSION_REVOKED_REASONS],
      enumName: 'auth_sessions_revoked_reason_enum',
      nullable: true,
    },
  },
});
