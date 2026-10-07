import { EntitySchema } from 'typeorm';

/** Persistence shape of one counter row. Lives in infrastructure only. */
export interface AbuseCounterRow {
  scope: string;
  key: Buffer;
  window_start: Date;
  count: number;
  blocked_until: Date | null;
  expires_at: Date;
}

export const AbuseCounterSchema = new EntitySchema<AbuseCounterRow>({
  name: 'AbuseCounter',
  tableName: 'abuse_counters',
  columns: {
    scope: { type: String, primary: true },
    key: { type: 'bytea', primary: true },
    window_start: { type: 'timestamptz' },
    count: { type: Number },
    blocked_until: { type: 'timestamptz', nullable: true },
    expires_at: { type: 'timestamptz' },
  },
});
