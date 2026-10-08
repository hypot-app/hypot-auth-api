import { randomBytes, randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY = 86_400;
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const hash = (): Buffer => randomBytes(32);

interface SessionRow {
  revoked_at: Date | null;
  revoked_reason: string | null;
}

describe('SessionRepository (integration, ADR 35)', () => {
  let db: TestDatabase;
  let sessions: TypeOrmSessionRepository;
  let uow: TypeOrmUnitOfWork;
  let appA: string;
  let appB: string;
  let userA: string;
  let userB: string;

  const newApp = async (): Promise<string> => {
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
    return app.id;
  };
  const newUser = async (appId: string, email: string): Promise<string> => {
    const user = User.register({ id: randomUUID(), appId, email, passwordHash: '$2b$12$hash', now: T0 });
    await new TypeOrmUserRepository(db.dataSource).add(user);
    return user.id;
  };

  /** Opens a session at T0 (30 days) with a first token (7 days idle) and returns both. */
  const open = async (overrides: { appId?: string; userId?: string; sessionTtl?: number; tokenTtl?: number } = {}) => {
    const session = Session.open({
      id: randomUUID(),
      appId: overrides.appId ?? appA,
      userId: overrides.userId ?? userA,
      now: T0,
      absoluteTtlSeconds: overrides.sessionTtl ?? 30 * DAY,
    });
    const token = RefreshToken.issue({
      tokenHash: hash(),
      session,
      now: T0,
      idleTtlSeconds: overrides.tokenTtl ?? 7 * DAY,
    });
    await sessions.open(session, token);
    return { session, token };
  };
  const sessionRow = async (id: string): Promise<SessionRow> =>
    (await db.dataSource.query(`SELECT revoked_at, revoked_reason FROM auth_sessions WHERE id = $1`, [id]))[0];

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
    appA = await newApp();
    appB = await newApp();
    userA = await newUser(appA, 'ana@example.com');
    userB = await newUser(appA, 'bob@example.com');
  });

  describe('open and addToken', () => {
    it('stores the session and its first token, bound to the app and the user', async () => {
      const { session, token } = await open();

      expect(await sessions.findTokenState(token.tokenHash)).toEqual({
        sessionId: session.id,
        appId: appA,
        userId: userA,
        tokenExpiresAt: at(7 * DAY),
        consumedAt: null,
        consumedIpHash: null,
        replacedByHash: null,
        graceUsedAt: null,
        tokenRevokedAt: null,
        sessionExpiresAt: at(30 * DAY),
        sessionRevokedAt: null,
      });
    });

    it('joins the unit of work: a rollback leaves neither the session nor the token', async () => {
      const session = Session.open({ id: randomUUID(), appId: appA, userId: userA, now: T0, absoluteTtlSeconds: DAY });
      const token = RefreshToken.issue({ tokenHash: hash(), session, now: T0, idleTtlSeconds: DAY });

      await expect(
        uow.run(async () => {
          await sessions.open(session, token);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');

      expect(await sessions.findTokenState(token.tokenHash)).toBeNull();
      expect(await db.dataSource.query(`SELECT 1 FROM auth_sessions WHERE id = $1`, [session.id])).toEqual([]);
    });

    it('stores a successor token in the same session', async () => {
      const { session } = await open();
      const successor = RefreshToken.issue({ tokenHash: hash(), session, now: at(60), idleTtlSeconds: 7 * DAY });

      await sessions.addToken(successor);

      expect(await sessions.findTokenState(successor.tokenHash)).toMatchObject({
        sessionId: session.id,
        tokenExpiresAt: at(60 + 7 * DAY),
        consumedAt: null,
      });
    });
  });

  describe('consume', () => {
    it('rotates an unused token once: returns its session, and records the successor and IP hashes', async () => {
      const { session, token } = await open();
      const successor = hash();
      const ip = hash();

      const consumed = await sessions.consume(token.tokenHash, appA, at(100), successor, ip);

      expect(consumed).toEqual({ sessionId: session.id, userId: userA, sessionExpiresAt: at(30 * DAY) });
      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({
        consumedAt: at(100),
        replacedByHash: successor,
        consumedIpHash: ip,
      });
    });

    it('answers null for an unknown token', async () => {
      await open();

      expect(await sessions.consume(hash(), appA, at(1), hash(), hash())).toBeNull();
    });

    it('answers null for a replay of a token that was already rotated, and leaves the first rotation as it was', async () => {
      const { token } = await open();
      const firstSuccessor = hash();
      await sessions.consume(token.tokenHash, appA, at(100), firstSuccessor, hash());

      expect(await sessions.consume(token.tokenHash, appA, at(200), hash(), hash())).toBeNull();

      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ consumedAt: at(100), replacedByHash: firstSuccessor });
    });

    it('answers null for another app and does not consume the token', async () => {
      const { token } = await open();

      expect(await sessions.consume(token.tokenHash, appB, at(1), hash(), hash())).toBeNull();

      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ consumedAt: null });
    });

    it('stops at the idle expiry: valid one millisecond before it, null at it', async () => {
      const { token } = await open({ tokenTtl: 100 });

      expect(await sessions.consume(token.tokenHash, appA, new Date(at(100).getTime()), hash(), hash())).toBeNull();
      expect(await sessions.consume(token.tokenHash, appA, new Date(at(100).getTime() - 1), hash(), hash())).not.toBeNull();
    });

    it('stops at the absolute session expiry even when the token itself has not expired', async () => {
      const session = Session.open({ id: randomUUID(), appId: appA, userId: userA, now: T0, absoluteTtlSeconds: 100 });
      // Built by hand: a token that outlives its session, which RefreshToken.issue never produces.
      const token = RefreshToken.restore({ ...RefreshToken.issue({ tokenHash: hash(), session, now: T0, idleTtlSeconds: 10 * DAY }), expiresAt: at(10 * DAY) });
      await sessions.open(session, token);

      expect(await sessions.consume(token.tokenHash, appA, at(100), hash(), hash())).toBeNull();
      expect(await sessions.consume(token.tokenHash, appA, at(99), hash(), hash())).not.toBeNull();
    });

    it('answers null once the session is revoked', async () => {
      const { session, token } = await open();
      await sessions.revoke(session.id, 'logout', at(10));

      expect(await sessions.consume(token.tokenHash, appA, at(20), hash(), hash())).toBeNull();
    });

    it('answers null for a token that was revoked on its own', async () => {
      const { token } = await open();
      await sessions.revokeToken(token.tokenHash, at(10));

      expect(await sessions.consume(token.tokenHash, appA, at(20), hash(), hash())).toBeNull();
    });

    it('lets exactly one of many parallel rotations of one token win', async () => {
      const { token } = await open();

      const results = await Promise.all(
        Array.from({ length: 12 }, () => sessions.consume(token.tokenHash, appA, at(100), hash(), hash())),
      );

      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it('does not touch the other tokens of the session', async () => {
      const { session, token } = await open();
      const sibling = RefreshToken.issue({ tokenHash: hash(), session, now: T0, idleTtlSeconds: DAY });
      await sessions.addToken(sibling);

      await sessions.consume(token.tokenHash, appA, at(100), hash(), hash());

      expect(await sessions.findTokenState(sibling.tokenHash)).toMatchObject({ consumedAt: null });
    });
  });

  describe('revoke and revokeAllForUser', () => {
    it('revokes a session with its reason and time', async () => {
      const { session } = await open();

      await sessions.revoke(session.id, 'reuse_detected', at(10));

      expect(await sessionRow(session.id)).toEqual({ revoked_at: at(10), revoked_reason: 'reuse_detected' });
    });

    it('is idempotent: a second revoke keeps the first reason and time', async () => {
      const { session } = await open();
      await sessions.revoke(session.id, 'logout', at(10));

      await sessions.revoke(session.id, 'reuse_detected', at(20));

      expect(await sessionRow(session.id)).toEqual({ revoked_at: at(10), revoked_reason: 'logout' });
    });

    it('revokes only the named session', async () => {
      const first = await open();
      const second = await open();

      await sessions.revoke(first.session.id, 'logout', at(10));

      expect(await sessionRow(second.session.id)).toEqual({ revoked_at: null, revoked_reason: null });
    });

    it('revokes every active session of one account and returns how many, leaving other accounts alone', async () => {
      const first = await open();
      const second = await open();
      const alreadyRevoked = await open();
      await sessions.revoke(alreadyRevoked.session.id, 'logout', at(5));
      const other = await open({ userId: userB });

      const revoked = await sessions.revokeAllForUser(userA, 'password_changed', at(10));

      expect(revoked).toBe(2);
      expect(await sessionRow(first.session.id)).toEqual({ revoked_at: at(10), revoked_reason: 'password_changed' });
      expect(await sessionRow(second.session.id)).toEqual({ revoked_at: at(10), revoked_reason: 'password_changed' });
      expect(await sessionRow(alreadyRevoked.session.id)).toEqual({ revoked_at: at(5), revoked_reason: 'logout' });
      expect(await sessionRow(other.session.id)).toEqual({ revoked_at: null, revoked_reason: null });
    });
  });

  describe('revokeAll', () => {
    it('revokes every open session of every account and app, with the reason, and returns how many', async () => {
      const first = await open();
      const second = await open({ userId: userB });
      const otherApp = await open({ appId: appB });

      const revoked = await sessions.revokeAll('ops_revoke_all', at(10));

      expect(revoked).toBe(3);
      for (const { session } of [first, second, otherApp]) {
        expect(await sessionRow(session.id)).toEqual({ revoked_at: at(10), revoked_reason: 'ops_revoke_all' });
      }
    });

    it('leaves a session that was revoked before, or is already over, as it was, and does not count it', async () => {
      const live = await open();
      const done = await open();
      await sessions.revoke(done.session.id, 'logout', at(5));
      const over = await open({ sessionTtl: 60 });

      const revoked = await sessions.revokeAll('ops_revoke_all', at(120));

      expect(revoked).toBe(1);
      expect(await sessionRow(live.session.id)).toEqual({ revoked_at: at(120), revoked_reason: 'ops_revoke_all' });
      expect(await sessionRow(done.session.id)).toEqual({ revoked_at: at(5), revoked_reason: 'logout' });
      expect(await sessionRow(over.session.id)).toEqual({ revoked_at: null, revoked_reason: null });
    });

    it('returns 0 when there is nothing to revoke', async () => {
      expect(await sessions.revokeAll('ops_revoke_all', at(10))).toBe(0);
    });

    it('makes every token of those sessions unusable for a rotation', async () => {
      const { token } = await open();

      await sessions.revokeAll('ops_revoke_all', at(10));

      expect(await sessions.consume(token.tokenHash, appA, at(20), hash(), hash())).toBeNull();
    });
  });

  describe('touch', () => {
    const lastUsedAt = async (id: string): Promise<Date> =>
      (await db.dataSource.query(`SELECT last_used_at FROM auth_sessions WHERE id = $1`, [id]))[0].last_used_at;

    it('records when the session was last used, for that session only', async () => {
      const first = await open();
      const second = await open();

      await sessions.touch(first.session.id, at(90));

      expect(await lastUsedAt(first.session.id)).toEqual(at(90));
      expect(await lastUsedAt(second.session.id)).toEqual(T0);
    });

    it('joins the unit of work: a rollback leaves last_used_at as it was', async () => {
      const { session } = await open();

      await expect(
        uow.run(async () => {
          await sessions.touch(session.id, at(90));
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');

      expect(await lastUsedAt(session.id)).toEqual(T0);
    });
  });

  describe('reuse grace window storage', () => {
    it('claims the grace once for a rotated token and returns the successor hash', async () => {
      const { token } = await open();
      const successor = hash();
      await sessions.consume(token.tokenHash, appA, at(100), successor, hash());

      expect(await sessions.claimGrace(token.tokenHash, at(101))).toEqual(successor);
      expect(await sessions.claimGrace(token.tokenHash, at(102))).toBeNull();
      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ graceUsedAt: at(101) });
    });

    it('lets exactly one of many parallel claims win', async () => {
      const { token } = await open();
      await sessions.consume(token.tokenHash, appA, at(100), hash(), hash());

      const claims = await Promise.all(Array.from({ length: 12 }, () => sessions.claimGrace(token.tokenHash, at(101))));

      expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    });

    it('does not claim a token that was never rotated, an unknown token, or a revoked one', async () => {
      const unused = await open();
      expect(await sessions.claimGrace(unused.token.tokenHash, at(1))).toBeNull();
      // Nothing was claimed: a later rotation of this token must still be able to use its grace.
      expect(await sessions.findTokenState(unused.token.tokenHash)).toMatchObject({ graceUsedAt: null });
      expect(await sessions.claimGrace(hash(), at(1))).toBeNull();

      const rotated = await open();
      await sessions.consume(rotated.token.tokenHash, appA, at(100), hash(), hash());
      await db.dataSource.query(`UPDATE refresh_tokens SET revoked_at = $2 WHERE token_hash = $1`, [rotated.token.tokenHash, at(101)]);
      expect(await sessions.claimGrace(rotated.token.tokenHash, at(102))).toBeNull();
    });

    it('revokes a token that was never used, once', async () => {
      const { token } = await open();

      expect(await sessions.revokeToken(token.tokenHash, at(10))).toBe(true);
      expect(await sessions.revokeToken(token.tokenHash, at(20))).toBe(false);
      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ tokenRevokedAt: at(10) });
    });

    it('does not revoke a token that was already used, or an unknown one', async () => {
      const { token } = await open();
      await sessions.consume(token.tokenHash, appA, at(100), hash(), hash());

      expect(await sessions.revokeToken(token.tokenHash, at(101))).toBe(false);
      expect(await sessions.revokeToken(hash(), at(101))).toBe(false);
      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ tokenRevokedAt: null });
    });
  });

  describe('findTokenState', () => {
    it('answers null for an unknown token', async () => {
      expect(await sessions.findTokenState(hash())).toBeNull();
    });

    it('reports a revoked session', async () => {
      const { session, token } = await open();
      await sessions.revoke(session.id, 'logout', at(10));

      expect(await sessions.findTokenState(token.tokenHash)).toMatchObject({ sessionRevokedAt: at(10) });
    });
  });
});
