import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../platform/persistence/typeorm-unit-of-work';
import type { OneTimeToken, OneTimeTokenPurpose } from '../../domain/one-time-token';
import type { OneTimeTokenRepository, TokenApp } from '../../domain/one-time-token.repository';
import { OneTimeTokenMapper } from './one-time-token.mapper';
import { OneTimeTokenSchema, type OneTimeTokenRow } from './one-time-token.schema';

/** One statement: the row is checked and consumed together, so a token works at most once. */
const CONSUME_SQL = `
  UPDATE "one_time_tokens" SET "consumed_at" = $1
  WHERE "token_hash" = $2 AND "purpose" = $3 AND "consumed_at" IS NULL AND "expires_at" > $1
  RETURNING *`;

/** Read-only: the token's account's app. No state filter; consuming applies it. */
const FIND_APP_SQL = `
  SELECT a."id" AS app_id, a."client_id" AS client_id
  FROM "one_time_tokens" t
  JOIN "users" u ON u."id" = t."user_id"
  JOIN "apps" a ON a."id" = u."app_id"
  WHERE t."token_hash" = $1 AND t."purpose" = $2`;

@Injectable()
export class TypeOrmOneTimeTokenRepository implements OneTimeTokenRepository {
  constructor(private readonly dataSource: DataSource) {}

  async findAppByTokenHash(hash: Buffer, purpose: OneTimeTokenPurpose): Promise<TokenApp | null> {
    const rows: { app_id: string; client_id: string }[] = await currentManager(this.dataSource).query(FIND_APP_SQL, [
      hash,
      purpose,
    ]);
    const row = rows[0];
    return row === undefined ? null : { appId: row.app_id, clientId: row.client_id };
  }

  async save(token: OneTimeToken): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository<OneTimeTokenRow>(OneTimeTokenSchema)
      .save(OneTimeTokenMapper.toPersistence(token));
  }

  async consumeByHash(hash: Buffer, purpose: OneTimeTokenPurpose, now: Date): Promise<OneTimeToken | null> {
    // TypeORM's postgres driver answers an UPDATE with [rows, affectedCount].
    const [rows]: [OneTimeTokenRow[], number] = await currentManager(this.dataSource).query(CONSUME_SQL, [
      now,
      hash,
      purpose,
    ]);
    const row = rows[0];
    return row === undefined ? null : OneTimeTokenMapper.toDomain(row);
  }

  async invalidateOutstanding(userId: string, purpose: OneTimeTokenPurpose, now: Date): Promise<void> {
    await currentManager(this.dataSource)
      .createQueryBuilder()
      .update(OneTimeTokenSchema)
      .set({ consumed_at: now })
      .where('user_id = :userId AND purpose = :purpose AND consumed_at IS NULL', { userId, purpose })
      .execute();
  }
}
