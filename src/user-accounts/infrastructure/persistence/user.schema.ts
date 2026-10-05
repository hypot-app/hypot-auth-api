import { EntitySchema } from 'typeorm';

/** Persistence shape of an account. Lives in infrastructure only; the domain never sees it. */
export interface UserRow {
  id: string;
  app_id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

export const UserSchema = new EntitySchema<UserRow>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: 'uuid', primary: true },
    app_id: { type: 'uuid' },
    // citext: comparison and the UNIQUE(app_id, email) constraint ignore case.
    email: { type: 'citext' },
    password_hash: { type: String },
    email_verified_at: { type: 'timestamptz', nullable: true },
    password_changed_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz' },
  },
});
