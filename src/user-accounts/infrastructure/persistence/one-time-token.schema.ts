import { EntitySchema } from 'typeorm';

export interface OneTimeTokenRow {
  id: string;
  user_id: string;
  purpose: 'email_verification' | 'password_reset';
  token_hash: Buffer;
  expires_at: Date;
  consumed_at: Date | null;
}

export const OneTimeTokenSchema = new EntitySchema<OneTimeTokenRow>({
  name: 'OneTimeToken',
  tableName: 'one_time_tokens',
  columns: {
    id: { type: 'uuid', primary: true },
    user_id: { type: 'uuid' },
    purpose: {
      type: 'enum',
      enum: ['email_verification', 'password_reset'],
      enumName: 'one_time_tokens_purpose_enum',
    },
    token_hash: { type: 'bytea', unique: true },
    expires_at: { type: 'timestamptz' },
    consumed_at: { type: 'timestamptz', nullable: true },
  },
});
