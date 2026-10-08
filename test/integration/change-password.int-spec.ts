import { randomUUID } from 'node:crypto';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { DEFAULT_POLICIES } from '../../src/abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { ChangePasswordUseCase } from '../../src/password-management/application/change-password.use-case';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { RevokeAccountSessionsUseCase } from '../../src/session-auth/application/revoke-account-sessions.use-case';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { ok } from '../../src/shared-kernel/result';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { EmailOutboxSchema } from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { InMemoryAbuseCounterStore } from '../support/in-memory-abuse-counter-store';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY = 86_400;
const IP = ClientIp.from('203.0.113.7', undefined);
const generator = new CryptoTokenGenerator();

describe('changing a password on Postgres (integration)', () => {
  let db: TestDatabase;
  let sessions: TypeOrmSessionRepository;
  let clock: FixedClock;
  let app: App;
  let userId: string;

  const build = (revoke?: { execute(input: { userId: string; reason: 'password_changed' }): Promise<number> }, hasher = new FakePasswordHasher()) =>
    new ChangePasswordUseCase({
      resolveClient: new ResolveClientUseCase(new TypeOrmAppRepository(db.dataSource)),
      abuse: new AbuseGuard({ store: new InMemoryAbuseCounterStore(), policies: DEFAULT_POLICIES, clock }),
      authenticate: { execute: async () => ok({ accountId: userId, appId: app.id, clientId: app.clientId }) },
      users: new TypeOrmUserRepository(db.dataSource),
      hasher,
      sessions: revoke ?? new RevokeAccountSessionsUseCase({ sessions, clock }),
      outbox: new TypeOrmEmailOutbox(db.dataSource),
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
    });
  const input = { authorization: 'Bearer x', currentPassword: 'old passphrase', newPassword: 'a new passphrase', ip: IP };
  const hash = async (): Promise<string> => (await db.dataSource.query(`SELECT password_hash FROM users WHERE id = $1`, [userId]))[0].password_hash;
  const outboxCount = async (): Promise<number> => Number((await db.dataSource.query(`SELECT count(*) AS n FROM email_outbox`))[0].n);
  const openSession = async (): Promise<string> => {
    const session = Session.open({ id: randomUUID(), appId: app.id, userId, now: T0, absoluteTtlSeconds: 30 * DAY });
    await sessions.open(session, RefreshToken.issue({ tokenHash: generator.generate().hash, session, now: T0, idleTtlSeconds: 7 * DAY }));
    return session.id;
  };
  const revokedReason = async (id: string): Promise<string | null> =>
    (await db.dataSource.query(`SELECT revoked_reason FROM auth_sessions WHERE id = $1`, [id]))[0].revoked_reason;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, SessionSchema, RefreshTokenSchema, EmailOutboxSchema] });
    sessions = new TypeOrmSessionRepository(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    clock = new FixedClock(T0);
    app = App.restore({
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
      createdAt: T0,
      updatedAt: T0,
    });
    await new TypeOrmAppRepository(db.dataSource).save(app);
    userId = randomUUID();
    await new TypeOrmUserRepository(db.dataSource).add(
      User.register({ id: userId, appId: app.id, email: 'ana@example.com', passwordHash: 'hashed:old passphrase', now: T0 }).confirm(T0),
    );
  });

  it('writes the hash, revokes every session with the reason and queues the notice in one commit', async () => {
    const [s1, s2] = [await openSession(), await openSession()];

    expect(await build().execute(input)).toEqual({ ok: true, value: undefined });

    expect(await hash()).toBe('hashed:a new passphrase');
    expect([await revokedReason(s1), await revokedReason(s2)]).toEqual(['password_changed', 'password_changed']);
    expect(await outboxCount()).toBe(1);
  });

  it('rolls the hash back and queues no notice when revoking the sessions fails', async () => {
    const session = await openSession();
    const failing = build({
      execute: async () => {
        throw new Error('revocation failed');
      },
    });

    await expect(failing.execute(input)).rejects.toThrow('revocation failed');

    expect(await hash()).toBe('hashed:old passphrase');
    expect(await revokedReason(session)).toBeNull();
    expect(await outboxCount()).toBe(0);
  });

  it('refuses the change, keeping the concurrent hash and revoking and queuing nothing, when the hash changed after the read', async () => {
    const session = await openSession();
    const hasher = new FakePasswordHasher();
    const hashNew = hasher.hash.bind(hasher);
    // A reset commits while this request is hashing the new password (the window bcrypt opens in production).
    hasher.hash = async (plain) => {
      await db.dataSource.query(`UPDATE users SET password_hash = 'hashed:reset passphrase' WHERE id = $1`, [userId]);
      return hashNew(plain);
    };

    const result = await build(undefined, hasher).execute(input);

    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_current_password' } });
    expect(await hash()).toBe('hashed:reset passphrase');
    expect(await revokedReason(session)).toBeNull();
    expect(await outboxCount()).toBe(0);
  });

  it('replacePassword swaps only while the stored hash is the expected one', async () => {
    const users = new TypeOrmUserRepository(db.dataSource);

    expect(await users.replacePassword(userId, 'hashed:stale', 'hashed:x', T0)).toBe(false);
    expect(await users.replacePassword(randomUUID(), 'hashed:old passphrase', 'hashed:x', T0)).toBe(false);
    expect(await hash()).toBe('hashed:old passphrase');

    expect(await users.replacePassword(userId, 'hashed:old passphrase', 'hashed:x', T0)).toBe(true);
    expect(await hash()).toBe('hashed:x');
  });
});
