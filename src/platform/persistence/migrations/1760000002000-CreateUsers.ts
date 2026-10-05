import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1760000002000 implements MigrationInterface {
  name = 'CreateUsers1760000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL,
        "app_id" uuid NOT NULL,
        "email" citext NOT NULL,
        "password_hash" text NOT NULL,
        "email_verified_at" timestamptz,
        "password_changed_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_users_app_id" FOREIGN KEY ("app_id") REFERENCES "apps" ("id"),
        CONSTRAINT "UQ_users_app_id_email" UNIQUE ("app_id", "email")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "users"`);
    // The citext extension stays: dropping it could break another schema that uses it,
    // and CREATE EXTENSION IF NOT EXISTS makes the next up() safe either way.
  }
}
