import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { EmailOutbox } from '../../domain/email-outbox';
import type { OutboxEmail } from '../../domain/outbox-email';
import { EmailOutboxMapper } from './email-outbox.mapper';
import { EmailOutboxSchema, type EmailOutboxRow } from './email-outbox.schema';

@Injectable()
export class TypeOrmEmailOutbox implements EmailOutbox {
  constructor(private readonly dataSource: DataSource) {}

  async save(email: OutboxEmail): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository<EmailOutboxRow>(EmailOutboxSchema)
      .save(EmailOutboxMapper.toPersistence(email));
  }

  async claimNextDue(now: Date): Promise<OutboxEmail | null> {
    const row = await currentManager(this.dataSource)
      .getRepository<EmailOutboxRow>(EmailOutboxSchema)
      .createQueryBuilder('o')
      .where('o.status = :status', { status: 'pending' })
      .andWhere('o.next_attempt_at <= :now', { now })
      .orderBy('o.next_attempt_at', 'ASC')
      .limit(1)
      .setLock('pessimistic_write')
      .setOnLocked('skip_locked')
      .getOne();
    return row ? EmailOutboxMapper.toDomain(row) : null;
  }
}
