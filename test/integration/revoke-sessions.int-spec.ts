import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { RevokeAccountSessionsUseCase } from '../../src/session-auth/application/revoke-account-sessions.use-case';
import { RevokeAllSessionsUseCase } from '../../src/session-auth/application/revoke-all-sessions.use-case';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY = 86_400;
const generator = new CryptoTokenGenerator();

describe('revoking sessions on Postgres (integration, ADR 35)', () => {
  let db: TestDatabase;
  let sessions: TypeOrmSessionRepository;
  let uow: TypeOrmUnitOfWork;
  let clock: FixedClock;
  let appId: string;
  let ana: string;
  let bob: string;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, SessionSchema, RefreshTokenSchema] });
    sessions = new TypeOrmSessionRepository(db.dataSource);
    uow = new TypeOrmUnitOfWork(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    clock = new FixedClock(T0);
    const app = App.restore({
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
    appId = app.id;
    const users = new TypeOrmUserRepository(db.dataSource);
    [ana, bob] = [randomUUID(), randomUUID()];
    await users.add(User.register({ id: ana, appId, email: 'ana@example.com', passwordHash: '$2b$12$hash', now: T0 }));
    await users.add(User.register({ id: bob, appId, email: 'bob@example.com', passwordHash: '$2b$12$hash', now: T0 }));
  });

  const open = async (userId: string): Promise<string> => {
    const session = Session.open({ id: randomUUID(), appId, userId, now: T0, absoluteTtlSeconds: 30 * DAY });
    await sessions.open(session, RefreshToken.issue({ tokenHash: generator.generate().hash, session, now: T0, idleTtlSeconds: 7 * DAY }));
    return session.id;
  };
  const row = async (id: string) =>
    (await db.dataSource.query(`SELECT revoked_at, revoked_reason FROM auth_sessions WHERE id = $1`, [id]))[0];

  it('RevokeAccountSessionsUseCase revokes all sessions of that account, stores the reason and leaves other accounts alone', async () => {
    const [a1, a2, b1] = [await open(ana), await open(ana), await open(bob)];
    clock.advanceMs(5_000);

    const revoked = await new RevokeAccountSessionsUseCase({ sessions, clock }).execute({ userId: ana, reason: 'password_changed' });

    expect(revoked).toBe(2);
    const at = new Date(T0.getTime() + 5_000);
    expect(await row(a1)).toEqual({ revoked_at: at, revoked_reason: 'password_changed' });
    expect(await row(a2)).toEqual({ revoked_at: at, revoked_reason: 'password_changed' });
    expect(await row(b1)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it('RevokeAccountSessionsUseCase joins the caller unit of work: a rollback un-revokes (the password write fails with it)', async () => {
    const a1 = await open(ana);
    const useCase = new RevokeAccountSessionsUseCase({ sessions, clock });

    await expect(
      uow.run(async () => {
        await useCase.execute({ userId: ana, reason: 'password_reset' });
        throw new Error('password write failed');
      }),
    ).rejects.toThrow('password write failed');

    expect(await row(a1)).toEqual({ revoked_at: null, revoked_reason: null });
  });

  it('RevokeAllSessionsUseCase revokes every open session with ops_revoke_all', async () => {
    const [a1, b1] = [await open(ana), await open(bob)];

    const revoked = await new RevokeAllSessionsUseCase({ sessions, clock }).execute();

    expect(revoked).toBe(2);
    expect(await row(a1)).toEqual({ revoked_at: T0, revoked_reason: 'ops_revoke_all' });
    expect(await row(b1)).toEqual({ revoked_at: T0, revoked_reason: 'ops_revoke_all' });
  });
});
