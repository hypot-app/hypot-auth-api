import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateEmailOutbox1760000001000 implements MigrationInterface {
  name = 'CreateEmailOutbox1760000001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "email_outbox_status_enum" AS ENUM ('pending', 'sent', 'failed')`);
    await queryRunner.query(`
      CREATE TABLE "email_outbox" (
        "id" uuid NOT NULL,
        "app_id" uuid NOT NULL,
        "to_address" text NOT NULL,
        "template" text NOT NULL,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "status" "email_outbox_status_enum" NOT NULL DEFAULT 'pending',
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" timestamptz NOT NULL,
        "last_error" text,
        "locked_until" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_outbox_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_email_outbox_app_id" FOREIGN KEY ("app_id") REFERENCES "apps" ("id")
      )
    `);
    // The worker only ever scans pending rows by due time.
    await queryRunner.query(
      `CREATE INDEX "IDX_email_outbox_pending_due" ON "email_outbox" ("next_attempt_at") WHERE "status" = 'pending'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "email_outbox"`);
    await queryRunner.query(`DROP TYPE "email_outbox_status_enum"`);
  }
}
