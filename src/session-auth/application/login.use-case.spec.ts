import { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import { ClientIp } from '../../abuse-protection/domain/client-ip';
import type { ClientRef } from '../../abuse-protection/domain/client-ref';
import { resolvePolicies, type PolicyOverrides } from '../../abuse-protection/domain/policy';
import { TemporarilyUnavailable } from '../../abuse-protection/domain/temporarily-unavailable';
import { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import { FixedClock } from '../../shared-kernel/clock';
import { hashToken, CryptoTokenGenerator } from '../../shared-kernel/token-generator';
import type { UnitOfWork } from '../../shared-kernel/unit-of-work';
import { ACCESS_TOKEN_TTL_SECONDS, type AccessTokenIssuer } from '../../token-lifecycle/domain/access-token';
import { User } from '../../user-accounts/domain/user';
import { anApp } from '../../../test/support/app-fixture';
import { InMemoryAbuseCounterStore } from '../../../test/support/in-memory-abuse-counter-store';
import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { FakePasswordHasher, InMemoryUserRepository } from '../../../test/support/in-memory-user-accounts';
import type { RefreshToken } from '../domain/refresh-token';
import type { Session } from '../domain/session';
import { LoginUseCase, type LoginInput } from './login.use-case';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const DAY_SECONDS = 86_400;
const SHOP_ORIGIN = 'https://shop.example';
const IP_X = ClientIp.from('203.0.113.9', undefined);
const DUMMY_HASH = 'hashed:dummy-password-nobody-has';
const PASSWORD = 'correct horse';

const shop = anApp({ id: '11111111-1111-4111-8111-111111111111', clientId: 'app_shop', allowedOrigins: [SHOP_ORIGIN] });
const blog = anApp({ id: '22222222-2222-4222-8222-222222222222', clientId: 'app_blog', allowedOrigins: ['https://blog.example'] });

/** Every collaborator records into one ordered log, so tests can assert what ran before what. */
function setup(overrides: PolicyOverrides = {}) {
  const events: string[] = [];
  const clock = new FixedClock(T0);
  const apps = new InMemoryAppRepository();
  const users = new InMemoryUserRepository();
  const store = new InMemoryAbuseCounterStore();
  const guard = new AbuseGuard({ store, policies: resolvePolicies(overrides), clock });
  const verifies: { password: string; hash: string }[] = [];
  const clients: ClientRef[] = [];
  const opened: { session: Session; token: RefreshToken }[] = [];
  const issued: { accountId: string; clientId: string }[] = [];
  const failures = { openingSession: false };

  const originalFind = users.findByAppAndEmail.bind(users);
  users.findByAppAndEmail = async (appId, email) => {
    events.push('lookup');
    return originalFind(appId, email);
  };
  const hasher = new FakePasswordHasher();
  hasher.verify = async (password, hash) => {
    events.push('verify');
    verifies.push({ password, hash });
    return hash === `hashed:${password}`;
  };
  for (const method of ['checkLoginIp', 'beginLoginAttempt', 'recordLoginSuccess'] as const) {
    const original = guard[method].bind(guard) as (...args: unknown[]) => Promise<unknown>;
    (guard as unknown as Record<string, unknown>)[method] = async (client: ClientRef, ...rest: unknown[]) => {
      events.push(method);
      if (method === 'checkLoginIp') clients.push(client);
      return original(client, ...rest);
    };
  }
  const issuer: AccessTokenIssuer = {
    async issue(input) {
      events.push('issue');
      issued.push(input);
      return { token: `jwt-for-${input.accountId}`, expiresAt: new Date(T0.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000) };
    },
  };
  const uow: UnitOfWork = {
    async run(work) {
      events.push('uow:start');
      const result = await work();
      events.push('uow:end');
      return result;
    },
  };
  const sessions = {
    async open(session: Session, token: RefreshToken) {
      events.push('open');
      if (failures.openingSession) throw new Error('database down');
      opened.push({ session, token });
    },
  };
  const login = new LoginUseCase({
    resolveClient: new ResolveClientUseCase(apps),
    abuse: guard,
    users,
    hasher,
    dummyHash: DUMMY_HASH,
    sessions,
    tokens: new CryptoTokenGenerator(),
    accessTokens: issuer,
    clock,
    uow,
    ttls: { idleSeconds: 7 * DAY_SECONDS, absoluteSeconds: 30 * DAY_SECONDS },
  });

  const addUser = async (app = shop, email = 'ana@example.com', confirmed = true): Promise<User> => {
    const registered = User.register({ id: `user-${email}-${app.clientId}`, appId: app.id, email, passwordHash: `hashed:${PASSWORD}`, now: T0 });
    const user = confirmed ? registered.confirm(T0) : registered;
    await users.add(user);
    return user;
  };
  const attempt = (overrides: Partial<LoginInput> = {}) =>
    login.execute({ clientId: 'app_shop', origin: undefined, email: 'ana@example.com', password: PASSWORD, ip: IP_X, ...overrides });

  return { events, failures, store, clock, apps, users, verifies, clients, opened, issued, addUser, attempt, ready: Promise.all([apps.save(shop), apps.save(blog)]) };
}

describe('LoginUseCase', () => {
  describe('success', () => {
    it('issues an access token for the account and app, and a refresh token stored only as its hash', async () => {
      const t = setup();
      await t.ready;
      const user = await t.addUser();

      const result = await t.attempt();

      if (!result.ok) throw new Error('expected a successful login');
      expect(result.value).toEqual({
        accessToken: `jwt-for-${user.id}`,
        expiresIn: 3600,
        refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      });
      expect(t.issued).toEqual([{ accountId: user.id, clientId: 'app_shop' }]);
      expect(t.opened).toHaveLength(1);
      expect(t.opened[0]!.token.tokenHash).toEqual(hashToken(result.value.refreshToken));
    });

    it('opens a session bound to the app and the user: 30 days absolute, first token idle for 7 days', async () => {
      const t = setup();
      await t.ready;
      const user = await t.addUser();

      await t.attempt();

      const { session, token } = t.opened[0]!;
      expect(session).toMatchObject({ appId: shop.id, userId: user.id, revokedAt: null });
      expect(session.expiresAt).toEqual(new Date('2026-04-02T10:00:00.000Z'));
      expect(token).toMatchObject({ sessionId: session.id, consumedAt: null });
      expect(token.expiresAt).toEqual(new Date('2026-03-10T10:00:00.000Z'));
    });

    it('normalizes the email: case and surrounding spaces do not matter', async () => {
      const t = setup();
      await t.ready;
      await t.addUser();

      expect((await t.attempt({ email: '  ANA@Example.COM ' })).ok).toBe(true);
    });

    it('runs in order: IP limit, attempt count, lookup, one verify, the session and the access token in one unit of work, then the success refund', async () => {
      const t = setup();
      await t.ready;
      await t.addUser();

      await t.attempt();

      expect(t.events).toEqual([
        'checkLoginIp',
        'beginLoginAttempt',
        'lookup',
        'verify',
        'uow:start',
        'open',
        'issue',
        'uow:end',
        'recordLoginSuccess',
      ]);
    });

    it('refunds the pair counter, so a success does not use up the allowance of the next failures', async () => {
      const t = setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      await t.ready;
      await t.addUser();

      await t.attempt({ password: 'wrong password' });
      await t.attempt();
      await t.attempt({ password: 'wrong password' });
      await t.attempt({ password: 'wrong password' });

      // Without the refund the 3rd attempt would already be blocked, and only 3 would reach bcrypt.
      expect(t.verifies).toHaveLength(4);
    });

    it('does not refund the pair counter when the session cannot be opened', async () => {
      const t = setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      await t.ready;
      await t.addUser();

      await t.attempt({ password: 'wrong password' });
      t.failures.openingSession = true;
      await expect(t.attempt()).rejects.toThrow('database down');
      t.failures.openingSession = false;
      const third = await t.attempt({ password: 'wrong password' });

      // The failed login still counted: wrong + failed success = 2, so the 3rd attempt is blocked before bcrypt.
      expect(third.ok).toBe(false);
      expect(t.events).not.toContain('recordLoginSuccess');
      expect(t.verifies).toHaveLength(2);
    });

    it('does not find an account of another app with the same email', async () => {
      const t = setup();
      await t.ready;
      await t.addUser(blog);

      const result = await t.attempt();

      expect(result.ok).toBe(false);
      expect(t.opened).toHaveLength(0);
    });
  });

  describe('one bcrypt comparison per processed attempt', () => {
    it('compares against the real hash for a wrong password', async () => {
      const t = setup();
      await t.ready;
      const user = await t.addUser();

      const result = await t.attempt({ password: 'wrong password' });

      expect(result).toEqual({ ok: false, error: { clientBound: true } });
      expect(t.verifies).toEqual([{ password: 'wrong password', hash: user.passwordHash }]);
    });

    it('compares against the dummy hash for an unknown email, with no early return', async () => {
      const t = setup();
      await t.ready;

      const result = await t.attempt({ email: 'nobody@example.com' });

      expect(result).toEqual({ ok: false, error: { clientBound: true } });
      expect(t.verifies).toEqual([{ password: PASSWORD, hash: DUMMY_HASH }]);
    });

    it('still compares the right password of an unconfirmed account, and issues nothing', async () => {
      const t = setup();
      await t.ready;
      const user = await t.addUser(shop, 'ana@example.com', false);

      const result = await t.attempt();

      expect(result.ok).toBe(false);
      expect(t.verifies).toEqual([{ password: PASSWORD, hash: user.passwordHash }]);
      expect(t.opened).toHaveLength(0);
      expect(t.issued).toHaveLength(0);
    });

    it.each([
      ['an unknown client_id', { clientId: 'app_missing' }],
      ['an origin that is not bound to the app', { origin: 'https://blog.example' }],
    ])('compares against the dummy hash for %s and does not look the account up', async (_name, input) => {
      const t = setup();
      await t.ready;
      await t.addUser();

      const result = await t.attempt(input);

      expect(result).toEqual({ ok: false, error: { clientBound: false } });
      expect(t.verifies).toEqual([{ password: PASSWORD, hash: DUMMY_HASH }]);
      expect(t.events).not.toContain('lookup');
    });

    it('compares against the dummy hash for a malformed email and does not look anything up', async () => {
      const t = setup();
      await t.ready;

      const result = await t.attempt({ email: 'not an email' });

      expect(result).toEqual({ ok: false, error: { clientBound: true } });
      expect(t.verifies).toEqual([{ password: PASSWORD, hash: DUMMY_HASH }]);
      expect(t.events).not.toContain('lookup');
    });

    it.each([
      ['a NUL byte', `${PASSWORD}\0tail`],
      ['more than 72 bytes', 'a'.repeat(73)],
    ])('compares a password with %s as an empty string, since bcrypt cannot hash it as given', async (_name, password) => {
      const t = setup();
      await t.ready;
      const user = await t.addUser();

      await t.attempt({ password });

      expect(t.verifies).toEqual([{ password: '', hash: user.passwordHash }]);
    });
  });

  describe('abuse protection', () => {
    it('counts the attempt before the lookup and before bcrypt, once, and the unknown email too', async () => {
      const t = setup();
      await t.ready;

      await t.attempt({ email: 'nobody@example.com' });

      expect(t.events).toEqual(['checkLoginIp', 'beginLoginAttempt', 'lookup', 'verify']);
    });

    it('answers a rate-limited IP with the generic failure and no bcrypt, lookup or attempt count', async () => {
      const t = setup({ login_ip: { limit: 1 } });
      await t.ready;
      await t.addUser();
      await t.attempt();
      t.events.length = 0;

      const result = await t.attempt();

      expect(result).toEqual({ ok: false, error: { clientBound: true } });
      expect(t.events).toEqual(['checkLoginIp']);
    });

    it('answers a blocked (account, IP) pair without bcrypt, even for the correct password, and issues nothing', async () => {
      const t = setup({ login_account_ip: { limit: 2, blockSeconds: 900 } });
      await t.ready;
      await t.addUser();
      await t.attempt({ password: 'wrong password' });
      await t.attempt({ password: 'wrong password' });
      t.events.length = 0;
      t.opened.length = 0;

      const result = await t.attempt();

      expect(result).toEqual({ ok: false, error: { clientBound: true } });
      expect(t.events).toEqual(['checkLoginIp', 'beginLoginAttempt']);
      expect(t.opened).toHaveLength(0);
    });

    it('locks the account for every IP once its own limit is reached, without bcrypt', async () => {
      const t = setup({ login_account: { limit: 2, blockSeconds: 900 } });
      await t.ready;
      await t.addUser();
      await t.attempt({ password: 'wrong password', ip: ClientIp.from('203.0.113.1', undefined) });
      await t.attempt({ password: 'wrong password', ip: ClientIp.from('203.0.113.2', undefined) });
      t.events.length = 0;

      const result = await t.attempt({ ip: ClientIp.from('203.0.113.3', undefined) });

      expect(result.ok).toBe(false);
      expect(t.events).toEqual(['checkLoginIp', 'beginLoginAttempt']);
    });

    it('limits and blocks an unknown email the same way as a known one', async () => {
      const t = setup({ login_account_ip: { limit: 1, blockSeconds: 900 } });
      await t.ready;
      await t.attempt({ email: 'nobody@example.com' });
      t.events.length = 0;

      await t.attempt({ email: 'nobody@example.com' });

      expect(t.events).toEqual(['checkLoginIp', 'beginLoginAttempt']);
    });

    it('keys a resolved client by the app and every unknown client_id by one shared sentinel', async () => {
      const t = setup();
      await t.ready;

      await t.attempt();
      await t.attempt({ clientId: 'app_random_1' });
      await t.attempt({ clientId: 'app_random_2' });
      await t.attempt({ origin: 'https://blog.example' });

      expect(t.clients.map((client) => client.key)).toEqual([`app:${shop.id}`, 'unknown', 'unknown', 'unknown']);
    });

    it('limits random client_id values from one IP together', async () => {
      const t = setup({ login_ip: { limit: 2 } });
      await t.ready;

      await t.attempt({ clientId: 'app_random_1' });
      await t.attempt({ clientId: 'app_random_2' });
      t.verifies.length = 0;
      await t.attempt({ clientId: 'app_random_3' });

      expect(t.verifies).toHaveLength(0);
    });

    it('shares the attempt counters of every malformed email instead of keeping one row per string', async () => {
      const t = setup({ login_account_ip: { limit: 1, blockSeconds: 900 } });
      await t.ready;

      await t.attempt({ email: 'first garbage' });
      t.verifies.length = 0;
      await t.attempt({ email: 'second garbage' });

      expect(t.verifies).toHaveLength(0);
    });

    it.each(['login_ip', 'login_account_ip', 'login_account'] as const)(
      'fails closed when the limiter store is down for %s: TemporarilyUnavailable, no session',
      async (scope) => {
        const t = setup();
        await t.ready;
        await t.addUser();
        const hit = t.store.hit.bind(t.store);
        t.store.hit = async (hitScope, ...rest) => {
          if (hitScope === scope) throw new Error('db down');
          return hit(hitScope, ...rest);
        };

        await expect(t.attempt()).rejects.toBeInstanceOf(TemporarilyUnavailable);

        expect(t.opened).toHaveLength(0);
        expect(t.issued).toHaveLength(0);
      },
    );
  });
});
