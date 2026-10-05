import { EntitySchema } from 'typeorm';

/** Persistence shape of an app. Lives in infrastructure only; the domain never sees it. */
export interface AppRow {
  id: string;
  client_id: string;
  name: string;
  client_type: 'public' | 'confidential';
  client_secret_hash: Buffer | null;
  redirect_uris: string[];
  allowed_origins: string[];
  email_from: string | null;
  email_confirmation_url: string | null;
  password_reset_url: string | null;
  status: 'active' | 'inactive';
  created_at: Date;
  updated_at: Date;
}

export const AppSchema = new EntitySchema<AppRow>({
  name: 'App',
  tableName: 'apps',
  columns: {
    id: { type: 'uuid', primary: true },
    client_id: { type: String, unique: true },
    name: { type: String },
    client_type: { type: 'enum', enum: ['public', 'confidential'], enumName: 'apps_client_type_enum' },
    client_secret_hash: { type: 'bytea', nullable: true },
    redirect_uris: { type: String, array: true },
    allowed_origins: { type: String, array: true },
    email_from: { type: String, nullable: true },
    email_confirmation_url: { type: String, nullable: true },
    password_reset_url: { type: String, nullable: true },
    status: { type: 'enum', enum: ['active', 'inactive'], enumName: 'apps_status_enum', default: 'active' },
    created_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz' },
  },
});
