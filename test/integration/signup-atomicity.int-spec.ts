import { randomUUID } from 'node:crypto';
import type { AbuseCounterStore } from '../../src/abuse-protection/domain/abuse-counter.store';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { DEFAULT_POLICIES } from '../../src/abuse-protection/domain/policy';
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
import { PostgresAbuseCounterStore } from '../../src/abuse-protection/infrastructure/persistence/postgres-abuse-counter.store';
import { AbuseCounterSchema } from '../../src/abuse-protection/infrastructure/persistence/abuse-counter.schema';
import { InMemoryAbuseCounterStore } from '../support/in-memory-abuse-counter-store';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

/** The account and its email commit together (ADR 18): if queueing fails, no account is left behind. */
describe('signup atomicity (integration)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, OneTimeTokenSchema, EmailOutboxSchema, AbuseCounterSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  /** A signup whose outbox write always fails, over the given counter store. */
  async function buildSignup(store: AbuseCounterStore) {
    const apps = new TypeOrmAppRepository(db.dataSource);
    const now = new Date();
    const shop = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: ['https://shop.example'],
      emailFrom: null,
      emailConfirmationUrl: 'https://shop.example/confirm',
      passwordResetUrl: 'https://shop.example/reset',
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
      abuse: new AbuseGuard({ store, policies: DEFAULT_POLICIES, clock }),
      users: new TypeOrmUserRepository(db.dataSource),
      hasher: new FakePasswordHasher(),
      confirmations: new ConfirmationIssuer({ tokens: new CryptoTokenGenerator(), oneTimeTokens, outbox: brokenOutbox, clock }),
      outbox: brokenOutbox,
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
    });
    return { signup, shop };
  }

  it('rolls back the account and its token when the outbox write fails', async () => {
    const { signup, shop } = await buildSignup(new InMemoryAbuseCounterStore());

    await expect(
      signup.execute({
        clientId: shop.clientId,
        email: 'ana@example.com',
        password: 'correct horse',
        ip: ClientIp.from('203.0.113.7', undefined),
      }),
    ).rejects.toThrow('outbox unavailable');

    const counts: { users: string; tokens: string }[] = await db.dataSource.query(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM one_time_tokens) AS tokens`,
    );
    expect(counts[0]).toEqual({ users: '0', tokens: '0' });
  });

  it('keeps the email_account hit made before the transaction when the transaction fails (real counter store)', async () => {
    const { signup, shop } = await buildSignup(new PostgresAbuseCounterStore(db.dataSource));

    await expect(
      signup.execute({
        clientId: shop.clientId,
        email: 'ana@example.com',
        password: 'correct horse',
        ip: ClientIp.from('203.0.113.7', undefined),
      }),
    ).rejects.toThrow('outbox unavailable');

    // The account rolled back, the count did not: it ran on its own connection, before the unit of work.
    const counters: { scope: string; count: number }[] = await db.dataSource.query(
      `SELECT scope, count FROM abuse_counters WHERE scope = 'email_account'`,
    );
    expect(counters).toEqual([{ scope: 'email_account', count: 1 }]);
    const users: { n: string }[] = await db.dataSource.query(`SELECT count(*) AS n FROM users`);
    expect(users[0]).toEqual({ n: '0' });
  });
});
