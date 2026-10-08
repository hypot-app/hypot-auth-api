import { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ClientRef } from '../../abuse-protection/domain/client-ref';
import { resolvePolicies, type PolicyOverrides } from '../../abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { FixedClock } from '../../shared-kernel/clock';
import { CryptoTokenGenerator, hashToken } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from '../../token-lifecycle/domain/access-token';
import { anApp } from '../../../test/support/app-fixture';
import { InMemoryAbuseCounterStore } from '../../../test/support/in-memory-abuse-counter-store';
import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { InMemorySessionRepository } from '../../../test/support/in-memory-session.repository';
import { hashClientIp } from '../domain/ip-hash';
import { RefreshToken } from '../domain/refresh-token';
import { Session } from '../domain/session';
import { RefreshSessionUseCase, type RefreshSessionInput } from './refresh-session.use-case';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;
const SHOP_ORIGIN = 'https://shop.example';
const IP_X = ClientIp.from('203.0.113.9', undefined);
const GENERATOR = new CryptoTokenGenerator();

const shop = anApp({ id: '11111111-1111-4111-8111-111111111111', clientId: 'app_shop', allowedOrigins: [SHOP_ORIGIN] });
const blog = anApp({ id: '22222222-2222-4222-8222-222222222222', clientId: 'app_blog', allowedOrigins: ['https://blog.example'] });
const parked = anApp({ id: '33333333-3333-4333-8333-333333333333', clientId: 'app_parked', status: 'inactive' });

function setup(overrides: PolicyOverrides = {}, reuseGraceSeconds = 10) {
  const events: string[] = [];
  const clock = new FixedClock(T0);
  const apps = new InMemoryAppRepository();
  const store = new InMemoryAbuseCounterStore();
  const guard = new AbuseGuard({ store, policies: resolvePolicies(overrides), clock });
  const sessions = new InMemorySessionRepository();
  const clients: ClientRef[] = [];
  const issued: { accountId: string; clientId: string }[] = [];
  const failures = { issuing: false };

  const originalCheck = guard.checkClientIp.bind(guard);
  guard.checkClientIp = async (scope, client, ip) => {
    events.push(`check:${scope}`);
    clients.push(client);
    return originalCheck(scope, client, ip);
  };
  for (const method of ['consume', 'findTokenState', 'addToken', 'touch', 'revoke', 'claimGrace', 'revokeToken'] as const) {
    const original = sessions[method].bind(sessions) as (...args: unknown[]) => Promise<unknown>;
    (sessions as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      events.push(method);
      return original(...args);
    };
  }
  const issuer: AccessTokenIssuer = {
    async issue(input) {
      events.push('issue');
      if (failures.issuing) throw new Error('signer down');
      issued.push(input);
      return {
        token: `jwt-for-${input.accountId}-${issued.length}`,
        expiresAt: new Date(clock.now().getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      };
    },
  };
  const uow: UnitOfWork = {
    async run(work) {
      events.push('uow:start');
      const restore = sessions.snapshot();
      try {
        const result = await work();
        events.push('uow:end');
        return result;
      } catch (error) {
        restore();
        events.push('uow:rollback');
        throw error;
      }
    },
  };
  const refresh = new RefreshSessionUseCase({
    resolveClient: new ResolveClientUseCase(apps),
    abuse: guard,
    sessions,
    tokens: GENERATOR,
    accessTokens: issuer,
    clock,
    uow,
    ttls: { idleSeconds: 7 * DAY_SECONDS, absoluteSeconds: 30 * DAY_SECONDS, reuseGraceSeconds },
  });

  /** A session opened at T0 with a first token whose raw value the test holds. */
  const login = async (options: { app?: typeof shop; userId?: string; absoluteSeconds?: number } = {}) => {
    const session = Session.open({
      id: `session-${sessions.sessions.size + 1}`,
      appId: (options.app ?? shop).id,
      userId: options.userId ?? 'user-ana',
      now: clock.now(),
      absoluteTtlSeconds: options.absoluteSeconds ?? 30 * DAY_SECONDS,
    });
    const first = GENERATOR.generate();
    await sessions.open(
      session,
      RefreshToken.issue({ tokenHash: first.hash, session, now: clock.now(), idleTtlSeconds: 7 * DAY_SECONDS }),
    );
    events.length = 0;
    sessions.calls.length = 0;
    return { sessionId: session.id, token: first.token };
  };
  const attempt = (refreshToken: string, overrides: Partial<RefreshSessionInput> = {}) =>
    refresh.execute({ clientId: 'app_shop', origin: undefined, refreshToken, ip: IP_X, ...overrides });
  const ok = async (refreshToken: string, overrides: Partial<RefreshSessionInput> = {}) => {
    const result = await attempt(refreshToken, overrides);
    if (!result.ok) throw new Error(`expected a successful refresh, got ${JSON.stringify(result.error)}`);
    return result.value;
  };

  return {
    events,
    clock,
    sessions,
    store,
    clients,
    issued,
    failures,
    login,
    attempt,
    ok,
    ready: Promise.all([apps.save(shop), apps.save(blog), apps.save(parked)]),
  };
}

const INVALID_GRANT = { ok: false, error: { kind: 'invalid_grant', clientBound: true } };

describe('RefreshSessionUseCase', () => {
  describe('rotation', () => {
    it('returns a new access token and a new refresh token, and stores only the hash of the new one', async () => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      const tokens = await t.ok(token);

      expect(tokens).toEqual({
        accessToken: 'jwt-for-user-ana-1',
        expiresIn: 3600,
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(tokens.refreshToken).not.toBe(token);
      expect(t.issued).toEqual([{ accountId: 'user-ana', clientId: 'app_shop' }]);
      expect(t.sessions.token(hashToken(tokens.refreshToken))).toMatchObject({ consumedAt: null, revokedAt: null });
    });

    it('marks the presented token used, with the successor hash and the hash of the caller IP', async () => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      const { refreshToken } = await t.ok(token);

      expect(t.sessions.token(hashToken(token))).toMatchObject({
        consumedAt: T0,
        replacedByHash: hashToken(refreshToken),
        consumedIpHash: hashClientIp(IP_X),
      });
    });

    it('consumes, stores the successor, touches the session and signs in one unit of work, after the IP limit', async () => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      await t.ok(token);

      expect(t.events).toEqual(['check:refresh_ip', 'uow:start', 'consume', 'addToken', 'touch', 'issue', 'uow:end']);
    });

    it('sets last_used_at of the session to the refresh time', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      t.clock.advanceMs(3_600_000);

      await t.ok(token);

      expect(t.sessions.sessions.get(sessionId)!.lastUsedAt).toEqual(new Date(T0.getTime() + 3_600_000));
    });

    it('gives the successor a fresh idle expiry and never extends the absolute expiry of the session', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      const absolute = t.sessions.sessions.get(sessionId)!.expiresAt;
      t.clock.advanceMs(6 * DAY_SECONDS * 1000);

      const { refreshToken } = await t.ok(token);

      expect(t.sessions.token(hashToken(refreshToken))!.expiresAt).toEqual(new Date(T0.getTime() + 13 * DAY_SECONDS * 1000));
      expect(t.sessions.sessions.get(sessionId)!.expiresAt).toEqual(absolute);
    });

    it('caps the idle expiry of the successor at the session expiry', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ absoluteSeconds: 8 * DAY_SECONDS });
      t.clock.advanceMs(5 * DAY_SECONDS * 1000);

      const { refreshToken } = await t.ok(token);

      expect(t.sessions.token(hashToken(refreshToken))!.expiresAt).toEqual(t.sessions.sessions.get(sessionId)!.expiresAt);
    });

    it('leaves everything as it was when the access token cannot be signed', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      t.failures.issuing = true;

      await expect(t.attempt(token)).rejects.toThrow('signer down');

      expect(t.sessions.token(hashToken(token))).toMatchObject({ consumedAt: null, replacedByHash: null });
      expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedAt: null, lastUsedAt: T0 });
      expect(t.events).toContain('uow:rollback');
    });
  });

  describe('session closing mid-request', () => {
    it('refuses a rotation when the session is revoked after the token was consumed, and rolls it back', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      const add = t.sessions.addToken.bind(t.sessions);
      t.sessions.addToken = async (next) => {
        await add(next);
        await t.sessions.revoke(sessionId, 'logout', t.clock.now());
      };

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.events).toContain('uow:rollback');
      expect(t.issued).toHaveLength(0);
      expect(t.sessions.token(hashToken(token))).toMatchObject({ consumedAt: null, replacedByHash: null });
      expect(t.sessions.tokenCount()).toBe(1);
    });
  });

  describe('invalid_grant', () => {
    it('is the same answer for an unknown token, a malformed one, a token of another app and an expired one', async () => {
      const t = setup();
      await t.ready;
      const other = await t.login({ app: blog });
      const idle = await t.login();
      t.clock.advanceMs(8 * DAY_SECONDS * 1000);
      const fresh = await t.login();

      const answers = await Promise.all([
        t.attempt(GENERATOR.generate().token),
        t.attempt('not a token!'),
        t.attempt(''),
        t.attempt(other.token),
        t.attempt(idle.token),
      ]);

      for (const answer of answers) expect(answer).toEqual(INVALID_GRANT);
      expect((await t.attempt(fresh.token)).ok).toBe(true);
    });

    it('does not look a malformed token up', async () => {
      const t = setup();
      await t.ready;

      await t.attempt('not a token!');

      expect(t.events).toEqual(['check:refresh_ip']);
    });

    it('fails for an expired session without revoking anything', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ absoluteSeconds: DAY_SECONDS });
      t.clock.advanceMs(2 * DAY_SECONDS * 1000);

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    });

    it('fails for a revoked session and keeps its first reason', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      await t.sessions.revoke(sessionId, 'logout', T0);

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedAt: T0, revokedReason: 'logout' });
    });

    it('does not revoke the session of a token of another app, and leaves that token unused', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ app: blog });

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
      expect(t.sessions.token(hashToken(token))!.consumedAt).toBeNull();
    });

    it('does not revoke the session of a consumed token of another app', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ app: blog });
      // The owner of the token rotates it through its own app first.
      await t.sessions.consume(hashToken(token), blog.id, T0, GENERATOR.generate().hash, hashClientIp(IP_X));

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    });
  });

  describe('reuse', () => {
    it('revokes the whole session when a consumed token is presented again', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();
      await t.ok(token);
      t.clock.advanceMs(11_000);

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)).toMatchObject({
        revokedAt: new Date(T0.getTime() + 11_000),
        revokedReason: 'reuse_detected',
      });
    });

    it('revokes the session when a revoked token of the same app is presented', async () => {
      const t = setup();
      await t.ready;
      const { sessionId } = await t.login();
      const revoked = GENERATOR.generate();
      await t.sessions.addToken(
        RefreshToken.restore({
          tokenHash: revoked.hash,
          sessionId,
          createdAt: T0,
          expiresAt: new Date(T0.getTime() + DAY_SECONDS * 1000),
          consumedAt: null,
          replacedByHash: null,
          consumedIpHash: null,
          graceUsedAt: null,
          revokedAt: T0,
        }),
      );

      expect(await t.attempt(revoked.token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedReason: 'reuse_detected' });
    });

    it('revokes every token of the session: a replay of R1 after R1 to R2 to R3 ends R2 and R3', async () => {
      const t = setup();
      await t.ready;
      const { token: r1, sessionId } = await t.login();
      const r2 = (await t.ok(r1)).refreshToken;
      const r3 = (await t.ok(r2)).refreshToken;
      t.clock.advanceMs(11_000);

      expect(await t.attempt(r1)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      expect(await t.attempt(r3)).toEqual(INVALID_GRANT);
      expect(await t.attempt(r2)).toEqual(INVALID_GRANT);
    });
  });

  describe('reuse grace window (ADR 35)', () => {
    const IP_Y = ClientIp.from('198.51.100.7', undefined);
    const stateOf = (t: ReturnType<typeof setup>, token: string) => t.sessions.token(hashToken(token))!;

    /** R1 rotated into R2 at T0, from IP_X. */
    async function rotated(t: ReturnType<typeof setup>) {
      await t.ready;
      const { token: r1, sessionId } = await t.login();
      const r2 = (await t.ok(r1)).refreshToken;
      t.events.length = 0;
      return { r1, r2, sessionId };
    }

    it('(a) forgives a reuse of R1 inside the window from the same IP: a fresh pair R3, R2 revoked, the session alive', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      t.clock.advanceMs(5_000);

      const r3 = await t.ok(r1);

      expect(r3).toEqual({
        accessToken: 'jwt-for-user-ana-2',
        expiresIn: 3600,
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(r3.refreshToken).not.toBe(r2);
      expect(stateOf(t, r2)).toMatchObject({ revokedAt: new Date(T0.getTime() + 5_000), consumedAt: null });
      expect(stateOf(t, r3.refreshToken)).toMatchObject({ consumedAt: null, revokedAt: null, sessionId });
      expect(stateOf(t, r1).graceUsedAt).toEqual(new Date(T0.getTime() + 5_000));
      expect(t.sessions.sessions.get(sessionId)).toMatchObject({ revokedAt: null, lastUsedAt: new Date(T0.getTime() + 5_000) });
      expect(t.issued.at(-1)).toEqual({ accountId: 'user-ana', clientId: 'app_shop' });
    });

    it('claims, revokes the successor, stores R3, touches the session and signs in ONE unit of work', async () => {
      const t = setup();
      const { r1 } = await rotated(t);
      t.clock.advanceMs(5_000);

      await t.ok(r1);

      expect(t.events).toEqual([
        'check:refresh_ip',
        'uow:start',
        'consume',
        'uow:end',
        'findTokenState',
        'uow:start',
        'claimGrace',
        'revokeToken',
        'addToken',
        'touch',
        'issue',
        'uow:end',
      ]);
    });

    it('keeps the absolute expiry and caps R3 at the session expiry', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ absoluteSeconds: 8 * DAY_SECONDS });
      t.clock.advanceMs(5 * DAY_SECONDS * 1000);
      await t.ok(token);
      t.clock.advanceMs(3_000);

      const r3 = await t.ok(token);

      const session = t.sessions.sessions.get(sessionId)!;
      expect(session.expiresAt).toEqual(new Date(T0.getTime() + 8 * DAY_SECONDS * 1000));
      expect(stateOf(t, r3.refreshToken).expiresAt).toEqual(session.expiresAt);
    });

    it('(b) revokes the session for a reuse inside the window from a different IP', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      t.clock.advanceMs(5_000);

      expect(await t.attempt(r1, { ip: IP_Y })).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      expect(t.events).not.toContain('claimGrace');
      expect(stateOf(t, r2).revokedAt).toBeNull();
    });

    it('(c) revokes the session after the window, and accepts the exact end of it', async () => {
      const t = setup();
      const late = await rotated(t);
      t.clock.advanceMs(10_001);
      expect(await t.attempt(late.r1)).toEqual(INVALID_GRANT);
      expect(t.sessions.sessions.get(late.sessionId)!.revokedReason).toBe('reuse_detected');

      const edge = setup();
      const onTime = await rotated(edge);
      edge.clock.advanceMs(10_000);
      expect((await edge.attempt(onTime.r1)).ok).toBe(true);
    });

    it('(d) revokes the session on a second reuse of R1 inside the window', async () => {
      const t = setup();
      const { r1, sessionId } = await rotated(t);
      t.clock.advanceMs(2_000);
      const r3 = await t.ok(r1);
      t.clock.advanceMs(2_000);

      expect(await t.attempt(r1)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      // The first grace stays recorded: it is what refuses the second one.
      expect(stateOf(t, r1).graceUsedAt).toEqual(new Date(T0.getTime() + 2_000));
      expect(await t.attempt(r3.refreshToken)).toEqual(INVALID_GRANT);
    });

    it('(e) revokes the session when R2 was already used (R1 to R2 to R3), rolling the claim back', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      await t.ok(r2);
      t.clock.advanceMs(3_000);

      expect(await t.attempt(r1)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      expect(stateOf(t, r1).graceUsedAt).toBeNull();
      expect(t.events).toContain('uow:rollback');
    });

    it('(f) revokes the session when the window is 0', async () => {
      const t = setup({}, 0);
      const { r1, sessionId } = await rotated(t);

      expect(await t.attempt(r1)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      expect(t.events).not.toContain('claimGrace');
    });

    it('(g) revokes the session when the revoked successor R2 is presented later', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      t.clock.advanceMs(4_000);
      await t.ok(r1);

      expect(await t.attempt(r2)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
    });

    it('(h) counts IPv6 addresses of one /64 as the same IP, and another /64 as another', async () => {
      const home = ClientIp.from('2001:db8:1:2::1', undefined);
      const sameNet = ClientIp.from('2001:db8:1:2:aaaa:bbbb:cccc:dddd', undefined);
      const otherNet = ClientIp.from('2001:db8:1:3::1', undefined);

      const t = setup();
      await t.ready;
      const first = await t.login();
      await t.ok(first.token, { ip: home });
      t.clock.advanceMs(1_000);
      expect((await t.attempt(first.token, { ip: sameNet })).ok).toBe(true);

      const u = setup();
      await u.ready;
      const second = await u.login();
      await u.ok(second.token, { ip: home });
      u.clock.advanceMs(1_000);
      expect(await u.attempt(second.token, { ip: otherNet })).toEqual(INVALID_GRANT);
      expect(u.sessions.sessions.get(second.sessionId)!.revokedReason).toBe('reuse_detected');
    });

    it('(i) never takes the grace path for a token that has revoked_at, even a used one inside the window from the same IP', async () => {
      const t = setup();
      await t.ready;
      const { sessionId } = await t.login();
      const odd = GENERATOR.generate();
      await t.sessions.addToken(
        RefreshToken.restore({
          tokenHash: odd.hash,
          sessionId,
          createdAt: T0,
          expiresAt: new Date(T0.getTime() + DAY_SECONDS * 1000),
          consumedAt: T0,
          replacedByHash: GENERATOR.generate().hash,
          consumedIpHash: hashClientIp(IP_X),
          graceUsedAt: null,
          revokedAt: T0,
        }),
      );
      t.events.length = 0;

      expect(await t.attempt(odd.token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedReason).toBe('reuse_detected');
      expect(t.events).not.toContain('claimGrace');
    });

    it('does not forgive a reuse once the session is revoked or over', async () => {
      const revoked = setup();
      const a = await rotated(revoked);
      await revoked.sessions.revoke(a.sessionId, 'logout', T0);
      revoked.clock.advanceMs(2_000);
      expect(await revoked.attempt(a.r1)).toEqual(INVALID_GRANT);
      expect(revoked.sessions.sessions.get(a.sessionId)!.revokedReason).toBe('logout');
      expect(revoked.events).not.toContain('claimGrace');

      const over = setup();
      await over.ready;
      const b = await over.login({ absoluteSeconds: 60 });
      await over.ok(b.token);
      over.clock.advanceMs(61_000);
      over.events.length = 0;
      expect(await over.attempt(b.token)).toEqual(INVALID_GRANT);
      expect(over.events).not.toContain('claimGrace');
    });

    it('does not forgive a token of another app, and revokes nothing for it', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login({ app: blog });
      await t.sessions.consume(hashToken(token), blog.id, T0, GENERATOR.generate().hash, hashClientIp(IP_X));
      t.clock.advanceMs(1_000);

      expect(await t.attempt(token)).toEqual(INVALID_GRANT);

      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    });

    it('refuses the grace when the session is revoked after the eligibility read, and leaves nothing behind', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      t.clock.advanceMs(5_000);
      // A logout commits between the read of the token state and the unit of work.
      const read = t.sessions.findTokenState.bind(t.sessions);
      t.sessions.findTokenState = async (hash) => {
        const state = await read(hash);
        await t.sessions.revoke(sessionId, 'logout', t.clock.now());
        return state;
      };
      const issuedBefore = t.issued.length;

      expect(await t.attempt(r1)).toEqual(INVALID_GRANT);

      expect(t.issued).toHaveLength(issuedBefore);
      expect(t.events).toContain('uow:rollback');
      expect(stateOf(t, r1).graceUsedAt).toBeNull();
      expect(stateOf(t, r2).revokedAt).toBeNull();
      expect(t.sessions.sessions.get(sessionId)).toMatchObject({ lastUsedAt: T0 });
      expect([...t.sessions.sessions.values()].length).toBe(1);
      expect(t.sessions.tokenCount()).toBe(2);
    });

    it('leaves the claim, the revoked successor and R3 out when signing fails, and the session alive', async () => {
      const t = setup();
      const { r1, r2, sessionId } = await rotated(t);
      t.clock.advanceMs(1_000);
      t.failures.issuing = true;

      await expect(t.attempt(r1)).rejects.toThrow('signer down');

      expect(stateOf(t, r1).graceUsedAt).toBeNull();
      expect(stateOf(t, r2).revokedAt).toBeNull();
      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
    });
  });

  describe('client and origin', () => {
    it.each([
      ['unknown', 'app_nobody'],
      ['inactive', 'app_parked'],
    ])('answers invalid_client for an %s client and looks no token up', async (_name, clientId) => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      const result = await t.attempt(token, { clientId });

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_client' } });
      expect(t.events).toEqual(['check:refresh_ip']);
    });

    it('answers the same invalid_grant as for an unknown token when the Origin is not bound to the client, flagged unbound for CORS', async () => {
      const t = setup();
      await t.ready;
      const { token, sessionId } = await t.login();

      const result = await t.attempt(token, { origin: 'https://blog.example' });

      expect(result).toEqual({ ok: false, error: { kind: 'invalid_grant', clientBound: false } });
      expect(t.sessions.token(hashToken(token))!.consumedAt).toBeNull();
      expect(t.sessions.sessions.get(sessionId)!.revokedAt).toBeNull();
      expect(t.events).toEqual(['check:refresh_ip']);
    });

    it('checks the Origin before any token is consumed, so a wrong origin cannot burn a valid token', async () => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      await t.attempt(token, { origin: 'https://evil.example' });
      const retry = await t.attempt(token, { origin: SHOP_ORIGIN });

      expect(retry.ok).toBe(true);
    });

    it('passes with the bound Origin and with no Origin at all', async () => {
      const t = setup();
      await t.ready;
      const a = await t.login();
      const b = await t.login();

      expect((await t.attempt(a.token, { origin: SHOP_ORIGIN })).ok).toBe(true);
      expect((await t.attempt(b.token, { origin: undefined })).ok).toBe(true);
    });
  });

  describe('refresh_ip limit', () => {
    it('is hit once per request, before any token lookup, for a resolved client and for the shared unknown one', async () => {
      const t = setup();
      await t.ready;
      const { token } = await t.login();

      await t.attempt(token);
      await t.attempt(token, { clientId: 'app_nobody' });
      await t.attempt(token, { clientId: 'app_other_nobody' });

      expect(t.events.filter((event) => event === 'check:refresh_ip')).toHaveLength(3);
      expect(t.events[0]).toBe('check:refresh_ip');
      expect(t.clients[1]).toEqual(t.clients[2]);
      expect(t.clients[0]).not.toEqual(t.clients[1]);
    });

    it('answers rate_limited with an integer Retry-After, identical for a valid and an invalid token, and consumes nothing', async () => {
      const t = setup({ refresh_ip: { limit: 1, windowSeconds: 900 } });
      await t.ready;
      const { token } = await t.login();
      await t.attempt('not a token!');
      t.events.length = 0;
      t.clock.advanceMs(100_500);

      const valid = await t.attempt(token);
      const invalid = await t.attempt(GENERATOR.generate().token);

      expect(valid).toEqual({ ok: false, error: { kind: 'rate_limited', retryAfterSeconds: 800 } });
      expect(invalid).toEqual(valid);
      expect(t.events).toEqual(['check:refresh_ip', 'check:refresh_ip']);
      expect(t.sessions.token(hashToken(token))!.consumedAt).toBeNull();
    });

    it('counts per client and IP: another IP is not limited', async () => {
      const t = setup({ refresh_ip: { limit: 1, windowSeconds: 900 } });
      await t.ready;
      const first = await t.login();
      const second = await t.login();

      expect((await t.attempt(first.token)).ok).toBe(true);
      expect((await t.attempt(first.token)).ok).toBe(false);
      expect((await t.attempt(second.token, { ip: ClientIp.from('198.51.100.7', undefined) })).ok).toBe(true);
    });
  });
});
