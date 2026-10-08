import { randomUUID } from 'node:crypto';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { DEFAULT_POLICIES } from '../../src/abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { ResetPasswordUseCase } from '../../src/password-management/application/reset-password.use-case';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { RevokeAccountSessionsUseCase } from '../../src/session-auth/application/revoke-account-sessions.use-case';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { OneTimeToken } from '../../src/user-accounts/domain/one-time-token';
import { User } from '../../src/user-accounts/domain/user';
import { OneTimeTokenSchema } from '../../src/user-accounts/infrastructure/persistence/one-time-token.schema';
import { TypeOrmOneTimeTokenRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-one-time-token.repository';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { InMemoryAbuseCounterStore } from '../support/in-memory-abuse-counter-store';
import { FakePasswordHasher } from '../support/in-memory-user-accounts';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY = 86_400;
const IP = ClientIp.from('203.0.113.7', undefined);
const generator = new CryptoTokenGenerator();

describe('resetting a password on Postgres (integration)', () => {
  let db: TestDatabase;
  let users: TypeOrmUserRepository;
  let oneTimeTokens: TypeOrmOneTimeTokenRepository;
  let sessions: TypeOrmSessionRepository;
  let clock: FixedClock;
  let appId: string;
  let userId: string;
  let token: string;

  const build = (revoke?: { execute(input: { userId: string; reason: 'password_reset' }): Promise<number> }) =>
    new ResetPasswordUseCase({
      resolveClient: new ResolveClientUseCase(new TypeOrmAppRepository(db.dataSource)),
      abuse: new AbuseGuard({ store: new InMemoryAbuseCounterStore(), policies: DEFAULT_POLICIES, clock }),
      oneTimeTokens,
      users,
      hasher: new FakePasswordHasher(),
      sessions: revoke ?? new RevokeAccountSessionsUseCase({ sessions, clock }),
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
    });
  const userRow = async (): Promise<{ password_hash: string; password_changed_at: Date; email_verified_at: Date | null }> =>
    (await db.dataSource.query(`SELECT password_hash, password_changed_at, email_verified_at FROM users WHERE id = $1`, [userId]))[0];
  const openSession = async (): Promise<string> => {
    const session = Session.open({ id: randomUUID(), appId, userId, now: T0, absoluteTtlSeconds: 30 * DAY });
    await sessions.open(session, RefreshToken.issue({ tokenHash: generator.generate().hash, session, now: T0, idleTtlSeconds: 7 * DAY }));
    return session.id;
  };
  const sessionRow = async (id: string) =>
    (await db.dataSource.query(`SELECT revoked_at, revoked_reason FROM auth_sessions WHERE id = $1`, [id]))[0];
  const consumedAt = async (): Promise<Date | null> =>
    (await db.dataSource.query(`SELECT consumed_at FROM one_time_tokens`))[0].consumed_at;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, OneTimeTokenSchema, SessionSchema, RefreshTokenSchema] });
    users = new TypeOrmUserRepository(db.dataSource);
    oneTimeTokens = new TypeOrmOneTimeTokenRepository(db.dataSource);
    sessions = new TypeOrmSessionRepository(db.dataSource);
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
    userId = randomUUID();
    await users.add(User.register({ id: userId, appId, email: 'ana@example.com', passwordHash: 'old-hash', now: T0 }).confirm(T0));
    const issued = generator.generate();
    token = issued.token;
    await oneTimeTokens.save(OneTimeToken.issue({ id: randomUUID(), userId, purpose: 'password_reset', tokenHash: issued.hash, now: T0 }));
  });

  it('writes the hash and password_changed_at, consumes the token and revokes every session with the reason', async () => {
    const [s1, s2] = [await openSession(), await openSession()];
    clock.advanceMs(5_000);

    expect(await build().execute({ token, newPassword: 'a new passphrase', ip: IP })).toEqual({ ok: true, value: undefined });

    const row = await userRow();
    expect(row.password_hash).toBe('hashed:a new passphrase');
    expect(row.password_changed_at).toEqual(new Date(T0.getTime() + 5_000));
    expect(row.email_verified_at).toEqual(T0);
    expect(await consumedAt()).toEqual(new Date(T0.getTime() + 5_000));
    for (const id of [s1, s2]) expect(await sessionRow(id)).toMatchObject({ revoked_reason: 'password_reset' });
    expect((await sessionRow(s1)).revoked_at).toEqual(new Date(T0.getTime() + 5_000));
  });

  it('lets exactly one of two concurrent submissions of the same token win, and keeps the winner password', async () => {
    const results = await Promise.all([
      build().execute({ token, newPassword: 'first passphrase', ip: IP }),
      build().execute({ token, newPassword: 'second passphrase', ip: IP }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loser = results.find((result) => !result.ok)!;
    expect(loser).toEqual({ ok: false, error: { kind: 'invalid_link', clientBound: false } });
    const winnerPassword = results[0]!.ok ? 'first passphrase' : 'second passphrase';
    expect((await userRow()).password_hash).toBe(`hashed:${winnerPassword}`);
  });

  it('rolls the hash back and leaves the token unused when revoking the sessions fails', async () => {
    const session = await openSession();
    const failing = build({
      execute: async () => {
        throw new Error('revocation failed');
      },
    });

    await expect(failing.execute({ token, newPassword: 'a new passphrase', ip: IP })).rejects.toThrow('revocation failed');

    expect((await userRow()).password_hash).toBe('old-hash');
    expect(await consumedAt()).toBeNull();
    expect((await sessionRow(session)).revoked_at).toBeNull();
    expect((await build().execute({ token, newPassword: 'a new passphrase', ip: IP })).ok).toBe(true);
  });

  it('updatePassword changes only the credential columns and reports an unknown account as false', async () => {
    const later = new Date(T0.getTime() + 60_000);

    expect(await users.updatePassword(userId, 'newer-hash', later)).toBe(true);
    expect(await users.updatePassword(randomUUID(), 'x', later)).toBe(false);

    const row = await userRow();
    expect(row.password_hash).toBe('newer-hash');
    expect(row.password_changed_at).toEqual(later);
    expect(row.email_verified_at).toEqual(T0);
  });
});
