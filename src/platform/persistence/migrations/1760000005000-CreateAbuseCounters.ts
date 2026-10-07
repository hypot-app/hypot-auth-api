import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAbuseCounters1760000005000 implements MigrationInterface {
  name = 'CreateAbuseCounters1760000005000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // UNLOGGED: written on every request, and losing the rows on a crash only restarts the windows (ADR 36).
    await queryRunner.query(`
      CREATE UNLOGGED TABLE "abuse_counters" (
        "scope" text NOT NULL,
        "key" bytea NOT NULL,
        "window_start" timestamptz NOT NULL,
        "count" integer NOT NULL,
        "blocked_until" timestamptz,
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "PK_abuse_counters" PRIMARY KEY ("scope", "key")
      )
    `);
    // The sweeper deletes by expiry.
    await queryRunner.query(`CREATE INDEX "IDX_abuse_counters_expires_at" ON "abuse_counters" ("expires_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "abuse_counters"`);
  }
}
