import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { DEFAULT_POLICIES } from '../../src/abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { PostgresAbuseCounterStore } from '../../src/abuse-protection/infrastructure/persistence/postgres-abuse-counter.store';
import { AbuseCounterSchema } from '../../src/abuse-protection/infrastructure/persistence/abuse-counter.schema';
import { buildTypeOrmOptions } from '../../src/platform/persistence/typeorm.options';
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

const POOL_MAX = 3;
const CONCURRENT_SIGNUPS = POOL_MAX * 4;

/**
 * C1 regression: the counter store takes its own pool connection, so a hit made inside the signup transaction
 * needs a second connection while holding the first. With as many concurrent signups as pool slots every
 * transaction waits for a connection no one can release. Here the pool is tiny and the signups outnumber it.
 */
describe('signup with the real abuse counter store on a small pool (integration)', () => {
  let db: TestDatabase;
  let smallPool: DataSource;

  beforeAll(async () => {
    const entities = [AppSchema, UserSchema, OneTimeTokenSchema, EmailOutboxSchema, AbuseCounterSchema];
    db = await startTestDatabase({ entities });
    const options = buildTypeOrmOptions({ url: db.url });
    smallPool = new DataSource({ ...options, entities, extra: { ...options.extra, max: POOL_MAX } });
    await smallPool.initialize();
  }, 180_000);

  afterAll(async () => {
    if (smallPool?.isInitialized) await smallPool.destroy();
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('completes more concurrent signups than the pool has connections', async () => {
    const apps = new TypeOrmAppRepository(smallPool);
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
    const clock = new SystemClock();
    const outbox = new TypeOrmEmailOutbox(smallPool);
    const signup = new SignupUseCase({
      resolveClient: new ResolveClientUseCase(apps),
      abuse: new AbuseGuard({ store: new PostgresAbuseCounterStore(smallPool), policies: DEFAULT_POLICIES, clock }),
      users: new TypeOrmUserRepository(smallPool),
      hasher: new FakePasswordHasher(),
      confirmations: new ConfirmationIssuer({
        tokens: new CryptoTokenGenerator(),
        oneTimeTokens: new TypeOrmOneTimeTokenRepository(smallPool),
        outbox,
        clock,
      }),
      outbox,
      clock,
      uow: new TypeOrmUnitOfWork(smallPool),
    });

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_SIGNUPS }, (_, i) =>
        signup.execute({
          clientId: shop.clientId,
          email: `user${i}@example.com`,
          password: 'correct horse',
          ip: ClientIp.from('203.0.113.7', undefined),
        }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    const counts: { users: string; emails: string }[] = await db.dataSource.query(
      `SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM email_outbox) AS emails`,
    );
    expect(counts[0]).toEqual({ users: String(CONCURRENT_SIGNUPS), emails: String(CONCURRENT_SIGNUPS) });
  }, 30_000);
});
