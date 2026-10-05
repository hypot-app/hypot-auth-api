import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { SystemClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { EmailOutboxSchema } from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { ConfirmEmailUseCase } from '../../src/user-accounts/application/confirm-email.use-case';
import { OneTimeToken } from '../../src/user-accounts/domain/one-time-token';
import { User } from '../../src/user-accounts/domain/user';
import type { UserRepository } from '../../src/user-accounts/domain/user.repository';
import { OneTimeTokenSchema } from '../../src/user-accounts/infrastructure/persistence/one-time-token.schema';
import { TypeOrmOneTimeTokenRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-one-time-token.repository';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

/** Confirming must change only the verification columns, never rewrite the whole row. */
describe('confirm email does not lose concurrent updates (integration)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, OneTimeTokenSchema, EmailOutboxSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('keeps a password hash committed after the account was read', async () => {
    const now = new Date();
    const shop = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [],
      emailFrom: null,
      postResetRedirectUri: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(db.dataSource).save(shop);

    const realUsers = new TypeOrmUserRepository(db.dataSource);
    const user = User.register({ id: randomUUID(), appId: shop.id, email: 'ana@example.com', passwordHash: 'old-hash', now });
    await realUsers.add(user);

    const oneTimeTokens = new TypeOrmOneTimeTokenRepository(db.dataSource);
    const { token: raw, hash } = new CryptoTokenGenerator().generate();
    await oneTimeTokens.save(
      OneTimeToken.issue({ id: randomUUID(), userId: user.id, purpose: 'email_verification', tokenHash: hash, now }),
    );

    // A password change commits right after confirm read the account (the stale-read window).
    const users: UserRepository = {
      add: (u) => realUsers.add(u),
      markEmailVerified: (...args) => realUsers.markEmailVerified(...args),
      findByAppAndEmail: (...args) => realUsers.findByAppAndEmail(...args),
      findById: async (id) => {
        const found = await realUsers.findById(id);
        await db.dataSource.query(`UPDATE users SET password_hash = 'new-hash' WHERE id = $1`, [id]);
        return found;
      },
    };
    const confirm = new ConfirmEmailUseCase({
      oneTimeTokens,
      users,
      outbox: new TypeOrmEmailOutbox(db.dataSource),
      clock: new SystemClock(),
      uow: new TypeOrmUnitOfWork(db.dataSource),
    });

    expect(await confirm.execute(raw)).toEqual({ ok: true, value: undefined });

    const rows: { password_hash: string; email_verified_at: Date | null }[] = await db.dataSource.query(
      `SELECT password_hash, email_verified_at FROM users WHERE id = $1`,
      [user.id],
    );
    expect(rows[0]?.email_verified_at).not.toBeNull();
    expect(rows[0]?.password_hash).toBe('new-hash');
  });
});
