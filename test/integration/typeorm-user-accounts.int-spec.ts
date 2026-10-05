import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { OneTimeToken, type OneTimeTokenPurpose } from '../../src/user-accounts/domain/one-time-token';
import { User } from '../../src/user-accounts/domain/user';
import { OneTimeTokenSchema } from '../../src/user-accounts/infrastructure/persistence/one-time-token.schema';
import { TypeOrmOneTimeTokenRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-one-time-token.repository';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('user and one-time-token repositories (integration)', () => {
  let db: TestDatabase;
  let users: TypeOrmUserRepository;
  let tokens: TypeOrmOneTimeTokenRepository;
  let uow: TypeOrmUnitOfWork;
  let appA: string;
  let appB: string;

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
      postResetRedirectUri: null,
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    });
    await new TypeOrmAppRepository(db.dataSource).save(app);
    return app.id;
  };

  const newUser = (appId: string, email = 'ana@example.com', passwordHash = '$2b$12$hash'): User =>
    User.register({ id: randomUUID(), appId, email, passwordHash, now: T0 });

  const newToken = (userId: string, overrides: { purpose?: OneTimeTokenPurpose } = {}): OneTimeToken =>
    OneTimeToken.issue({
      id: randomUUID(),
      userId,
      purpose: overrides.purpose ?? 'email_verification',
      tokenHash: Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
      now: T0,
    });

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, OneTimeTokenSchema] });
    users = new TypeOrmUserRepository(db.dataSource);
    tokens = new TypeOrmOneTimeTokenRepository(db.dataSource);
    uow = new TypeOrmUnitOfWork(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    appA = await newApp();
    appB = await newApp();
  });

  describe('UserRepository', () => {
    it('adds an account and reads it back as a domain User, by id and by app and email', async () => {
      const user = newUser(appA);
      expect(await users.add(user)).toBe(true);

      const byId = await users.findById(user.id);
      expect(byId).toBeInstanceOf(User);
      expect(byId).toEqual(user);
      expect(await users.findByAppAndEmail(appA, 'ana@example.com')).toEqual(user);
    });

    it('returns null for an unknown id, an unknown email, or the email of another app', async () => {
      await users.add(newUser(appA));
      expect(await users.findById(randomUUID())).toBeNull();
      expect(await users.findByAppAndEmail(appA, 'nobody@example.com')).toBeNull();
      expect(await users.findByAppAndEmail(appB, 'ana@example.com')).toBeNull();
    });

    it('returns false for a taken email in the same app, ignoring case, and keeps the first account', async () => {
      const first = newUser(appA, 'ana@example.com', 'hash-first');
      await users.add(first);

      expect(await users.add(newUser(appA, 'ANA@Example.com', 'hash-second'))).toBe(false);
      expect(await users.findByAppAndEmail(appA, 'ana@example.com')).toEqual(first);
    });

    it('accepts the same email in another app as an independent account', async () => {
      await users.add(newUser(appA, 'ana@example.com', 'hash-a'));
      expect(await users.add(newUser(appB, 'ana@example.com', 'hash-b'))).toBe(true);
      expect((await users.findByAppAndEmail(appB, 'ana@example.com'))?.passwordHash).toBe('hash-b');
    });

    it('lets exactly one of two concurrent adds of the same email win', async () => {
      const results = await Promise.all([users.add(newUser(appA)), users.add(newUser(appA))]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it('joins the unit of work: a rolled-back add leaves no account', async () => {
      const user = newUser(appA);
      await expect(
        uow.run(async () => {
          await users.add(user);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await users.findById(user.id)).toBeNull();
    });

    it('marks the email verified and keeps every other column', async () => {
      const user = newUser(appA);
      await users.add(user);
      await users.markEmailVerified(user.id, at(60));
      expect(await users.findById(user.id)).toEqual(user.confirm(at(60)));
    });

    it('keeps the first verification time when the account is already verified', async () => {
      const user = newUser(appA);
      await users.add(user);
      await users.markEmailVerified(user.id, at(60));
      await users.markEmailVerified(user.id, at(120));
      expect((await users.findById(user.id))?.emailVerifiedAt).toEqual(at(60));
    });

    it('ignores an unknown account', async () => {
      await expect(users.markEmailVerified(randomUUID(), at(60))).resolves.toBeUndefined();
    });
  });

  describe('OneTimeTokenRepository', () => {
    let userId: string;
    beforeEach(async () => {
      const user = newUser(appA);
      await users.add(user);
      userId = user.id;
    });

    it('consumes a valid token once and returns it as consumed', async () => {
      const token = newToken(userId);
      await tokens.save(token);

      const consumed = await tokens.consumeByHash(token.tokenHash, 'email_verification', at(10));
      expect(consumed).toBeInstanceOf(OneTimeToken);
      expect(consumed?.id).toBe(token.id);
      expect(consumed?.userId).toBe(userId);
      expect(consumed?.consumedAt).toEqual(at(10));
      expect(await tokens.consumeByHash(token.tokenHash, 'email_verification', at(11))).toBeNull();
    });

    it('returns null for an unknown hash', async () => {
      expect(await tokens.consumeByHash(Buffer.alloc(32, 9), 'email_verification', T0)).toBeNull();
    });

    it('treats a token as expired from its expiry instant', async () => {
      const token = newToken(userId);
      await tokens.save(token);
      expect(await tokens.consumeByHash(token.tokenHash, 'email_verification', token.expiresAt)).toBeNull();
      const justBefore = new Date(token.expiresAt.getTime() - 1);
      expect((await tokens.consumeByHash(token.tokenHash, 'email_verification', justBefore))?.id).toBe(token.id);
    });

    it('does not consume a token of another purpose, and leaves it usable', async () => {
      const token = newToken(userId, { purpose: 'password_reset' });
      await tokens.save(token);
      expect(await tokens.consumeByHash(token.tokenHash, 'email_verification', at(1))).toBeNull();
      expect((await tokens.consumeByHash(token.tokenHash, 'password_reset', at(2)))?.id).toBe(token.id);
    });

    it('lets exactly one of two concurrent consumes win', async () => {
      const token = newToken(userId);
      await tokens.save(token);
      const results = await Promise.all([
        tokens.consumeByHash(token.tokenHash, 'email_verification', at(1)),
        tokens.consumeByHash(token.tokenHash, 'email_verification', at(1)),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
    });

    it('supersedes the unconsumed tokens of one user and purpose only', async () => {
      const old = newToken(userId);
      const otherPurpose = newToken(userId, { purpose: 'password_reset' });
      const otherUser = newUser(appA, 'bo@example.com');
      await users.add(otherUser);
      const othersToken = newToken(otherUser.id);
      await Promise.all([old, otherPurpose, othersToken].map((token) => tokens.save(token)));

      await tokens.invalidateOutstanding(userId, 'email_verification', at(5));

      expect(await tokens.consumeByHash(old.tokenHash, 'email_verification', at(6))).toBeNull();
      expect((await tokens.consumeByHash(otherPurpose.tokenHash, 'password_reset', at(6)))?.id).toBe(otherPurpose.id);
      expect((await tokens.consumeByHash(othersToken.tokenHash, 'email_verification', at(6)))?.id).toBe(othersToken.id);
    });
  });
});
