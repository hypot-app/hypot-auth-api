import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { EmailOutbox } from '../../domain/email-outbox';
import type { OutboxEmail } from '../../domain/outbox-email';
import { EmailOutboxMapper } from './email-outbox.mapper';
import { EmailOutboxSchema, type EmailOutboxRow } from './email-outbox.schema';

/**
 * Both timestamps are computed here, not with now() in SQL: the lease written by the
 * claim must round-trip through a JS Date unchanged, because completion compares it
 * for equality (Postgres keeps microseconds, a Date keeps milliseconds).
 */
const CLAIM_SQL = `
  UPDATE "email_outbox" SET "locked_until" = $2
  WHERE "id" = (
    SELECT "id" FROM "email_outbox"
    WHERE "status" = 'pending'
      AND "next_attempt_at" <= $1
      AND ("locked_until" IS NULL OR "locked_until" < $1)
    ORDER BY "next_attempt_at"
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *`;

@Injectable()
export class TypeOrmEmailOutbox implements EmailOutbox {
  constructor(private readonly dataSource: DataSource) {}

  async save(email: OutboxEmail): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository<EmailOutboxRow>(EmailOutboxSchema)
      .save(EmailOutboxMapper.toPersistence(email));
  }

  async claimNextDue(now: Date, leaseMs: number): Promise<OutboxEmail | null> {
    const lockedUntil = new Date(now.getTime() + leaseMs);
    // TypeORM's postgres driver answers an UPDATE with [rows, affectedCount].
    const [rows]: [EmailOutboxRow[], number] = await currentManager(this.dataSource).query(CLAIM_SQL, [now, lockedUntil]);
    const row = rows[0];
    return row === undefined ? null : EmailOutboxMapper.toDomain(row);
  }

  async complete(email: OutboxEmail): Promise<boolean> {
    if (email.lockedUntil === null) return false;
    const { payload, status, attempts, next_attempt_at, last_error } = EmailOutboxMapper.toPersistence(email);
    const result = await currentManager(this.dataSource)
      .createQueryBuilder()
      .update(EmailOutboxSchema)
      .set({ payload, status, attempts, next_attempt_at, last_error, locked_until: null })
      .where('id = :id AND locked_until = :claimed', { id: email.id, claimed: email.lockedUntil })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
