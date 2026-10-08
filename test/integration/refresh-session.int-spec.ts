import { createHash, randomUUID } from 'node:crypto';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { RefreshSessionUseCase } from '../../src/session-auth/application/refresh-session.use-case';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { RefreshTokenSchema } from '../../src/session-auth/infrastructure/persistence/refresh-token.schema';
import { SessionSchema } from '../../src/session-auth/infrastructure/persistence/session.schema';
import { TypeOrmSessionRepository } from '../../src/session-auth/infrastructure/persistence/typeorm-session.repository';
import { FixedClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import type { AccessTokenIssuer } from '../../src/token-lifecycle/domain/access-token';
import { User } from '../../src/user-accounts/domain/user';
import { TypeOrmUserRepository } from '../../src/user-accounts/infrastructure/persistence/typeorm-user.repository';
import { UserSchema } from '../../src/user-accounts/infrastructure/persistence/user.schema';
import { InMemoryAbuseCounterStore } from '../support/in-memory-abuse-counter-store';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY = 86_400;
const IP = ClientIp.from('203.0.113.9', undefined);
const PARALLEL = 8;
const generator = new CryptoTokenGenerator();
const sha256 = (value: string): Buffer => createHash('sha256').update(value).digest();

describe('RefreshSessionUseCase on Postgres (integration, ADR 35)', () => {
  let db: TestDatabase;
  let sessions: TypeOrmSessionRepository;
  let clock: FixedClock;
  let refresh: RefreshSessionUseCase;
  let shop: App;
  let userId: string;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, UserSchema, SessionSchema, RefreshTokenSchema] });
    sessions = new TypeOrmSessionRepository(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    clock = new FixedClock(T0);
    const apps = new TypeOrmAppRepository(db.dataSource);
    shop = App.restore({
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
    await apps.save(shop);
    const user = User.register({ id: randomUUID(), appId: shop.id, email: 'ana@example.com', passwordHash: '$2b$12$hash', now: T0 });
    await new TypeOrmUserRepository(db.dataSource).add(user);
    userId = user.id;
    const issuer: AccessTokenIssuer = {
      async issue(input) {
        return { token: `jwt-${input.accountId}`, expiresAt: new Date(clock.now().getTime() + 3_600_000) };
      },
    };
    refresh = new RefreshSessionUseCase({
      resolveClient: new ResolveClientUseCase(apps),
      abuse: new AbuseGuard({ store: new InMemoryAbuseCounterStore(), policies: resolvePolicies({ refresh_ip: { limit: 1000 } }), clock }),
      sessions,
      tokens: generator,
      accessTokens: issuer,
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
      ttls: { idleSeconds: 7 * DAY, absoluteSeconds: 30 * DAY },
    });
  });

  const login = async (absoluteSeconds = 30 * DAY) => {
    const session = Session.open({ id: randomUUID(), appId: shop.id, userId, now: T0, absoluteTtlSeconds: absoluteSeconds });
    const first = generator.generate();
    await sessions.open(session, RefreshToken.issue({ tokenHash: first.hash, session, now: T0, idleTtlSeconds: 7 * DAY }));
    return { sessionId: session.id, token: first.token };
  };
  const attempt = (refreshToken: string) => refresh.execute({ clientId: shop.clientId, origin: undefined, refreshToken, ip: IP });
  const sessionRow = async (id: string) =>
    (await db.dataSource.query(`SELECT revoked_at, revoked_reason, expires_at, last_used_at FROM auth_sessions WHERE id = $1`, [id]))[0];

  it('lets exactly one of many parallel refreshes of one token win, and ends the session including the winner successor', async () => {
    const { token, sessionId } = await login();

    const results = await Promise.all(Array.from({ length: PARALLEL }, () => attempt(token)));

    const winners = results.filter((result) => result.ok);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(PARALLEL - 1);
    expect(await sessionRow(sessionId)).toMatchObject({ revoked_reason: 'reuse_detected' });
    // The winner holds a pair, but its session is over: its refresh token is worthless.
    const winner = winners[0]!;
    if (!winner.ok) throw new Error('unreachable');
    expect((await attempt(winner.value.refreshToken)).ok).toBe(false);
    const tokens = await db.dataSource.query(`SELECT token_hash FROM refresh_tokens`);
    expect(tokens).toHaveLength(2);
  });

  it('revokes R2 and R3 when R1 is replayed after R1 to R2 to R3', async () => {
    const { token: r1, sessionId } = await login();
    const second = await attempt(r1);
    const third = await attempt(second.ok ? second.value.refreshToken : '');
    if (!second.ok || !third.ok) throw new Error('expected two successful rotations');

    expect((await attempt(r1)).ok).toBe(false);

    expect(await sessionRow(sessionId)).toMatchObject({ revoked_reason: 'reuse_detected' });
    expect((await attempt(second.value.refreshToken)).ok).toBe(false);
    expect((await attempt(third.value.refreshToken)).ok).toBe(false);
  });

  it('stores the successor as a hash and links it from the consumed token', async () => {
    const { token } = await login();

    const result = await attempt(token);

    if (!result.ok) throw new Error('expected a successful refresh');
    const [consumed] = await db.dataSource.query(`SELECT replaced_by_hash FROM refresh_tokens WHERE token_hash = $1`, [sha256(token)]);
    expect(consumed.replaced_by_hash).toEqual(sha256(result.value.refreshToken));
    expect(JSON.stringify(await db.dataSource.query(`SELECT * FROM refresh_tokens`))).not.toContain(result.value.refreshToken);
  });

  it('does not extend the absolute expiry, caps the idle expiry at it, and records last_used_at', async () => {
    const { token, sessionId } = await login(8 * DAY);
    const before = await sessionRow(sessionId);
    clock.advanceMs(5 * DAY * 1000);

    const result = await attempt(token);

    if (!result.ok) throw new Error('expected a successful refresh');
    const after = await sessionRow(sessionId);
    expect(after.expires_at).toEqual(before.expires_at);
    expect(after.last_used_at).toEqual(new Date(T0.getTime() + 5 * DAY * 1000));
    const [successor] = await db.dataSource.query(`SELECT expires_at FROM refresh_tokens WHERE token_hash = $1`, [sha256(result.value.refreshToken)]);
    expect(successor.expires_at).toEqual(after.expires_at);
  });

  it('rolls the whole rotation back when the successor cannot be stored', async () => {
    const { token, sessionId } = await login();
    const broken = new RefreshSessionUseCase({
      resolveClient: new ResolveClientUseCase(new TypeOrmAppRepository(db.dataSource)),
      abuse: new AbuseGuard({ store: new InMemoryAbuseCounterStore(), policies: resolvePolicies({}), clock }),
      sessions: Object.assign(Object.create(sessions) as TypeOrmSessionRepository, {
        addToken: async () => {
          throw new Error('disk full');
        },
      }),
      tokens: generator,
      accessTokens: { issue: async () => ({ token: 'jwt', expiresAt: T0 }) },
      clock,
      uow: new TypeOrmUnitOfWork(db.dataSource),
      ttls: { idleSeconds: 7 * DAY, absoluteSeconds: 30 * DAY },
    });

    await expect(broken.execute({ clientId: shop.clientId, origin: undefined, refreshToken: token, ip: IP })).rejects.toThrow('disk full');

    const [row] = await db.dataSource.query(`SELECT consumed_at FROM refresh_tokens WHERE token_hash = $1`, [sha256(token)]);
    expect(row.consumed_at).toBeNull();
    expect((await sessionRow(sessionId)).revoked_at).toBeNull();
    expect((await attempt(token)).ok).toBe(true);
  });
});
