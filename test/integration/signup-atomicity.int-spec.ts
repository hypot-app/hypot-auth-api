import { randomUUID } from 'node:crypto';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { SystemClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import type { EmailOutbox } from '../../src/transactional-email/domain/email-outbox';
import { EmailOutboxSchema } from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { ConfirmationIssuer } from '../../src/user-accounts/application/confirmation-issuer';
import { SignupUseCase } from '../../src/user-accounts/application/signup.use-case';
import { OneTimeTokenSchema } from '../../src/user-accounts/infrastructure/persistence/one-time-token.schema';
import { TypeOrmOneTimeTokenRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-one-time-token.repository';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

/** The account and its email commit together (ADR 18): if queueing fails, no account is left behind. */
describe('signup atomicity (integration)', () => {
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

  it('rolls back the account and its token when the outbox write fails', async () => {
    const apps = new TypeOrmAppRepository(db.dataSource);
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
      emailConfirmationUrl: null,
      passwordResetUrl: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await apps.save(shop);
    const realOutbox = new TypeOrmEmailOutbox(db.dataSource);
    const brokenOutbox: EmailOutbox = {
      save: async () => {
        throw new Error('outbox unavailable');
      },
      claimNextDue: (...args) => realOutbox.claimNextDue(...args),
      complete: (...args) => realOutbox.complete(...args),
    };
    const clock = new SystemClock();
    const oneTimeTokens = new TypeOrmOneTimeTokenRepository(db.dataSource);
    const signup = new SignupUseCase({
      resolveClient: new ResolveClientUseCase(apps),
      users: new TypeOrmUserRepository(db.dataSource),
      hasher: new FakePasswordHasher(),
      confirmations: new ConfirmationIssuer({ tokens: new CryptoTokenGenerator(), oneTimeTokens, outbox: brokenOutbox, clock }),
      outbox: brokenOutbox,
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
    });

    await expect(
      signup.execute({ clientId: shop.clientId, email: 'ana@example.com', password: 'correct horse' }),
    ).rejects.toThrow('outbox unavailable');

    const counts: { users: string; tokens: string }[] = await db.dataSource.query(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM one_time_tokens) AS tokens`,
    );
    expect(counts[0]).toEqual({ users: '0', tokens: '0' });
  });
});
