import { EntitySchema } from 'typeorm';
import type { OutboxStatus } from '../../domain/outbox-email';

/** Persistence shape of one queued email. Lives in infrastructure only. */
export interface EmailOutboxRow {
  id: string;
  app_id: string;
  to_address: string;
  template: string;
  /** Raw template inputs (may hold a one-time token). Emptied once the row is terminal. */
  payload: Record<string, string>;
  status: OutboxStatus;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  created_at: Date;
}

export const EmailOutboxSchema = new EntitySchema<EmailOutboxRow>({
  name: 'EmailOutbox',
  tableName: 'email_outbox',
  columns: {
    id: { type: 'uuid', primary: true },
    app_id: { type: 'uuid' },
    to_address: { type: String },
    template: { type: String },
    payload: { type: 'jsonb' },
    status: { type: 'enum', enum: ['pending', 'sent', 'failed'], enumName: 'email_outbox_status_enum', default: 'pending' },
    attempts: { type: Number, default: 0 },
    next_attempt_at: { type: 'timestamptz' },
    last_error: { type: String, nullable: true },
    created_at: { type: 'timestamptz' },
  },
});
