import { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { FixedClock } from '../../shared-kernel/clock';
import { CryptoTokenGenerator, hashToken } from '../../shared-kernel/token-generator';
import { anApp } from '../../../test/support/app-fixture';
import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { InMemorySessionRepository } from '../../../test/support/in-memory-session.repository';
import { RefreshToken } from '../domain/refresh-token';
import { Session } from '../domain/session';
import { LogoutUseCase } from './logout.use-case';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;
const SHOP_ORIGIN = 'https://shop.example';
const GENERATOR = new CryptoTokenGenerator();

const shop = anApp({ id: '11111111-1111-4111-8111-111111111111', clientId: 'app_shop', allowedOrigins: [SHOP_ORIGIN] });
const blog = anApp({ id: '22222222-2222-4222-8222-222222222222', clientId: 'app_blog', allowedOrigins: ['https://blog.example'] });
const parked = anApp({ id: '33333333-3333-4333-8333-333333333333', clientId: 'app_parked', status: 'inactive' });

function setup() {
  const clock = new FixedClock(T0);
  const apps = new InMemoryAppRepository();
  const sessions = new InMemorySessionRepository();
  const logout = new LogoutUseCase({ resolveClient: new ResolveClientUseCase(apps), sessions, clock });

  const login = async (app = shop, absoluteSeconds = 30 * DAY_SECONDS) => {
    const session = Session.open({ id: `session-${sessions.sessions.size + 1}`, appId: app.id, userId: 'user-ana', now: T0, absoluteTtlSeconds: absoluteSeconds });
    const first = GENERATOR.generate();
    await sessions.open(session, RefreshToken.issue({ tokenHash: first.hash, session, now: T0, idleTtlSeconds: 7 * DAY_SECONDS }));
    sessions.calls.length = 0;
    return { sessionId: session.id, token: first.token, hash: first.hash };
  };
  const run = (refreshToken: string, overrides: { clientId?: string; origin?: string } = {}) =>
    logout.execute({ clientId: 'app_shop', origin: undefined, refreshToken, ...overrides });
  const reasonOf = (sessionId: string) => sessions.sessions.get(sessionId)!.revokedReason;

  return { clock, sessions, login, run, reasonOf, ready: Promise.all([apps.save(shop), apps.save(blog), apps.save(parked)]) };
}

describe('LogoutUseCase', () => {
  it('revokes the session of an active token with reason logout', async () => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();

    const result = await t.run(token);

    expect(result).toEqual({ clientBound: true });
    expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedAt: T0, revokedReason: 'logout' });
  });

  it('revokes the session of a token that was already rotated, or revoked on its own', async () => {
    const t = setup();
    await t.ready;
    const rotated = await t.login();
    await t.sessions.consume(rotated.hash, shop.id, T0, GENERATOR.generate().hash, Buffer.alloc(32));
    const revokedToken = await t.login();
    await t.sessions.revokeToken(revokedToken.hash, T0);

    await t.run(rotated.token);
    await t.run(revokedToken.token);

    expect(t.reasonOf(rotated.sessionId)).toBe('logout');
    expect(t.reasonOf(revokedToken.sessionId)).toBe('logout');
  });

  it('revokes the session of an expired token while the session is still open', async () => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();
    t.clock.advanceMs(8 * DAY_SECONDS * 1000);

    await t.run(token);

    expect(t.reasonOf(sessionId)).toBe('logout');
  });

  it('is idempotent: a second logout, or a logout of a revoked session, keeps the first reason and time', async () => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();
    await t.sessions.revoke(sessionId, 'reuse_detected', T0);
    t.clock.advanceMs(60_000);

    expect(await t.run(token)).toEqual({ clientBound: true });
    expect(await t.run(token)).toEqual({ clientBound: true });

    expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedAt: T0, revokedReason: 'reuse_detected' });
  });

  it('answers the same for an unknown token and a malformed one, and revokes nothing', async () => {
    const t = setup();
    await t.ready;
    const { sessionId } = await t.login();

    expect(await t.run(GENERATOR.generate().token)).toEqual({ clientBound: true });
    expect(await t.run('not a token!')).toEqual({ clientBound: true });
    expect(await t.run('')).toEqual({ clientBound: true });

    expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
  });

  it('does not look a malformed token up', async () => {
    const t = setup();
    await t.ready;

    await t.run('not a token!');

    expect(t.sessions.calls).toEqual([]);
  });

  it('revokes nothing for a token of another app', async () => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login(blog);

    const result = await t.run(token);

    expect(result).toEqual({ clientBound: true });
    expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
  });

  it('revokes with an Origin bound to the app', async () => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();

    expect(await t.run(token, { origin: SHOP_ORIGIN })).toEqual({ clientBound: true });

    expect(t.reasonOf(sessionId)).toBe('logout');
  });

  it.each([
    ["another app's origin", 'https://blog.example'],
    ['an origin no app owns', 'https://evil.example'],
  ])('revokes nothing, and looks nothing up, for %s, flagged unbound for CORS', async (_name, origin) => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();

    const result = await t.run(token, { origin });

    expect(result).toEqual({ clientBound: false });
    expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    expect(t.sessions.calls).toEqual([]);
  });

  it.each([
    ['unknown', 'app_nobody'],
    ['inactive', 'app_parked'],
  ])('answers the same for an %s client and revokes nothing', async (_name, clientId) => {
    const t = setup();
    await t.ready;
    const { token, sessionId } = await t.login();

    const result = await t.run(token, { clientId });

    expect(result).toEqual({ clientBound: false });
    expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    expect(hashToken(token)).toBeDefined();
  });
});
