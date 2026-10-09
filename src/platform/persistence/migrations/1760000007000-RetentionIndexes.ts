import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Indexes for the hourly retention sweep (ADR 35). `auth_sessions(expires_at)` already exists. */
export class RetentionIndexes1760000007000 implements MigrationInterface {
  name = 'RetentionIndexes1760000007000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE INDEX "IDX_one_time_tokens_expires_at" ON "one_time_tokens" ("expires_at")`);
    // Pending rows are the live queue and are never deleted, so they stay out of this index.
    await queryRunner.query(
      `CREATE INDEX "IDX_email_outbox_retention" ON "email_outbox" ("created_at") WHERE "status" IN ('sent', 'failed')`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_email_outbox_retention"`);
    await queryRunner.query(`DROP INDEX "IDX_one_time_tokens_expires_at"`);
  }
}
