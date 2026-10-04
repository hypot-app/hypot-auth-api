import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateApps1760000000000 implements MigrationInterface {
  name = 'CreateApps1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "apps_client_type_enum" AS ENUM ('public', 'confidential')`);
    await queryRunner.query(`CREATE TYPE "apps_status_enum" AS ENUM ('active', 'inactive')`);
    await queryRunner.query(`
      CREATE TABLE "apps" (
        "id" uuid NOT NULL,
        "client_id" text NOT NULL,
        "name" text NOT NULL,
        "client_type" "apps_client_type_enum" NOT NULL,
        "client_secret_hash" bytea,
        "redirect_uris" text[] NOT NULL DEFAULT '{}',
        "allowed_origins" text[] NOT NULL DEFAULT '{}',
        "email_from" text,
        "post_reset_redirect_uri" text,
        "status" "apps_status_enum" NOT NULL DEFAULT 'active',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_apps_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_apps_client_id" UNIQUE ("client_id"),
        CONSTRAINT "CHK_apps_secret_matches_type" CHECK (
          ("client_type" = 'public' AND "client_secret_hash" IS NULL)
          OR ("client_type" = 'confidential' AND "client_secret_hash" IS NOT NULL)
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "apps"`);
    await queryRunner.query(`DROP TYPE "apps_status_enum"`);
    await queryRunner.query(`DROP TYPE "apps_client_type_enum"`);
  }
}
