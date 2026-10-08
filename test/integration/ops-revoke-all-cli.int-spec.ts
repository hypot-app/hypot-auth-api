import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { runCli } from '../support/cli-harness';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const DAY = 86_400;
const generator = new CryptoTokenGenerator();

describe('ops:revoke-all CLI (integration)', () => {
  let db: TestDatabase;

  const cli = (args: string[]) => runCli(args, { databaseUrl: db.url });
  const openSession = async (appId: string, userId: string, absoluteSeconds = 30 * DAY): Promise<string> => {
    const now = new Date();
    const session = Session.open({ id: randomUUID(), appId, userId, now, absoluteTtlSeconds: absoluteSeconds });
    await new TypeOrmSessionRepository(db.dataSource).open(
      session,
      RefreshToken.issue({ tokenHash: generator.generate().hash, session, now, idleTtlSeconds: 7 * DAY }),
    );
    return session.id;
  };
  const reasons = async (): Promise<(string | null)[]> =>
    (await db.dataSource.query(`SELECT revoked_reason FROM auth_sessions ORDER BY id`)).map((row: { revoked_reason: string | null }) => row.revoked_reason);
  let appIds: string[];
  let userIds: string[];

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, SessionSchema, RefreshTokenSchema] });
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    appIds = [];
    userIds = [];
    for (const name of ['Shop', 'Blog']) {
      const now = new Date();
      const app = App.restore({
        id: randomUUID(),
        clientId: `app_${randomUUID().replaceAll('-', '')}`,
        name,
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
      await new TypeOrmAppRepository(db.dataSource).save(app);
      const user = User.register({ id: randomUUID(), appId: app.id, email: 'ana@example.com', passwordHash: '$2b$12$hash', now });
      await new TypeOrmUserRepository(db.dataSource).add(user);
      appIds.push(app.id);
      userIds.push(user.id);
    }
  });

  it('refuses to run without --yes, says why, prints no count and revokes nothing', async () => {
    await openSession(appIds[0]!, userIds[0]!);

    const run = await cli(['ops:revoke-all']);

    expect(run.errors.map((error) => error.message)).toEqual([expect.stringContaining('--yes')]);
    expect(run.out).toEqual([]);
    expect(await reasons()).toEqual([null]);
  });

  it('with --yes revokes every open session of every app with ops_revoke_all and prints the count', async () => {
    await openSession(appIds[0]!, userIds[0]!);
    await openSession(appIds[1]!, userIds[1]!);
    await openSession(appIds[1]!, userIds[1]!);

    const run = await cli(['ops:revoke-all', '--yes']);

    expect(run.errors).toEqual([]);
    expect(run.out).toEqual(['revoked sessions: 3']);
    expect(await reasons()).toEqual(['ops_revoke_all', 'ops_revoke_all', 'ops_revoke_all']);
  });

  it('counts only sessions that were still open, so a second run prints 0', async () => {
    await openSession(appIds[0]!, userIds[0]!);
    await openSession(appIds[0]!, userIds[0]!, 1);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    const first = await cli(['ops:revoke-all', '--yes']);
    const second = await cli(['ops:revoke-all', '--yes']);

    expect(first.out).toEqual(['revoked sessions: 1']);
    expect(second.out).toEqual(['revoked sessions: 0']);
  });
});
