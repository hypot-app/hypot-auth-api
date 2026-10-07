import { EntitySchema } from 'typeorm';

/** Persistence shape of a refresh token. Lives in infrastructure only; the domain never sees it. */
export interface RefreshTokenRow {
  token_hash: Buffer;
  session_id: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  replaced_by_hash: Buffer | null;
  consumed_ip_hash: Buffer | null;
  grace_used_at: Date | null;
  revoked_at: Date | null;
}

export const RefreshTokenSchema = new EntitySchema<RefreshTokenRow>({
  name: 'RefreshToken',
  tableName: 'refresh_tokens',
  columns: {
    token_hash: { type: 'bytea', primary: true },
    session_id: { type: 'uuid' },
    created_at: { type: 'timestamptz' },
    expires_at: { type: 'timestamptz' },
    consumed_at: { type: 'timestamptz', nullable: true },
    replaced_by_hash: { type: 'bytea', nullable: true },
    consumed_ip_hash: { type: 'bytea', nullable: true },
    grace_used_at: { type: 'timestamptz', nullable: true },
    revoked_at: { type: 'timestamptz', nullable: true },
  },
});
