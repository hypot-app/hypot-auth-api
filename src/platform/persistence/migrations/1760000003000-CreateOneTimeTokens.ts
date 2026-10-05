import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOneTimeTokens1760000003000 implements MigrationInterface {
  name = 'CreateOneTimeTokens1760000003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "one_time_tokens_purpose_enum" AS ENUM ('email_verification', 'password_reset')`);
    await queryRunner.query(`
      CREATE TABLE "one_time_tokens" (
        "id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "purpose" "one_time_tokens_purpose_enum" NOT NULL,
        "token_hash" bytea NOT NULL,
        "expires_at" timestamptz NOT NULL,
        "consumed_at" timestamptz,
        CONSTRAINT "PK_one_time_tokens_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_one_time_tokens_token_hash" UNIQUE ("token_hash"),
        CONSTRAINT "FK_one_time_tokens_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    // Superseding the outstanding tokens of a user looks them up by (user, purpose).
    await queryRunner.query(`CREATE INDEX "IDX_one_time_tokens_user_purpose" ON "one_time_tokens" ("user_id", "purpose")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "one_time_tokens"`);
    await queryRunner.query(`DROP TYPE "one_time_tokens_purpose_enum"`);
  }
}
