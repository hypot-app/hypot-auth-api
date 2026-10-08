import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAuthSessions1760000006000 implements MigrationInterface {
  name = 'CreateAuthSessions1760000006000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "auth_sessions_revoked_reason_enum" AS ENUM ('logout', 'reuse_detected', 'password_changed', 'password_reset', 'ops_revoke_all')`,
    );
    // A session is a refresh-token family (ADR 35): its id is the family id.
    await queryRunner.query(`
      CREATE TABLE "auth_sessions" (
        "id" uuid NOT NULL,
        "app_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL,
        "last_used_at" timestamptz NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "revoked_at" timestamptz,
        "revoked_reason" "auth_sessions_revoked_reason_enum",
        CONSTRAINT "PK_auth_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_app_id" FOREIGN KEY ("app_id") REFERENCES "apps" ("id"),
        CONSTRAINT "FK_auth_sessions_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    // Revoking every session of an account, and the retention job, look rows up by these.
    await queryRunner.query(`CREATE INDEX "IDX_auth_sessions_user_id" ON "auth_sessions" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_auth_sessions_expires_at" ON "auth_sessions" ("expires_at")`);
    // The token is stored only as its SHA-256 (ADR 13). The last four columns are the reuse grace window (ADR 35).
    await queryRunner.query(`
      CREATE TABLE "refresh_tokens" (
        "token_hash" bytea NOT NULL,
        "session_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        "replaced_by_hash" bytea,
        "consumed_ip_hash" bytea,
        "grace_used_at" timestamptz,
        "revoked_at" timestamptz,
        CONSTRAINT "PK_refresh_tokens_token_hash" PRIMARY KEY ("token_hash"),
        CONSTRAINT "FK_refresh_tokens_session_id" FOREIGN KEY ("session_id") REFERENCES "auth_sessions" ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_refresh_tokens_session_id" ON "refresh_tokens" ("session_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "refresh_tokens"`);
    await queryRunner.query(`DROP TABLE "auth_sessions"`);
    await queryRunner.query(`DROP TYPE "auth_sessions_revoked_reason_enum"`);
  }
}
