import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Apps link to their own pages from Auth emails. The URLs are nullable here because rows created before
 * this migration have none; the use cases require them for every new or updated app.
 * `post_reset_redirect_uri` goes away: no endpoint redirects users after a reset any more.
 */
export class AppEmailLinkUrls1760000004000 implements MigrationInterface {
  name = 'AppEmailLinkUrls1760000004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "apps" ADD COLUMN "email_confirmation_url" text`);
    await queryRunner.query(`ALTER TABLE "apps" ADD COLUMN "password_reset_url" text`);
    await queryRunner.query(`ALTER TABLE "apps" DROP COLUMN "post_reset_redirect_uri"`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "apps" ADD COLUMN "post_reset_redirect_uri" text`);
    await queryRunner.query(`ALTER TABLE "apps" DROP COLUMN "password_reset_url"`);
    await queryRunner.query(`ALTER TABLE "apps" DROP COLUMN "email_confirmation_url"`);
  }
}
