import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { DEFAULT_POLICIES, type PolicyTable } from '../../src/abuse-protection/domain/policy';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { FixedClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { ConfirmEmailUseCase } from '../../src/user-accounts/application/confirm-email.use-case';
import { ConfirmationIssuer } from '../../src/user-accounts/application/confirmation-issuer';
import { ResendConfirmationUseCase } from '../../src/user-accounts/application/resend-confirmation.use-case';
import { SignupUseCase } from '../../src/user-accounts/application/signup.use-case';
import { ForgotPasswordUseCase } from '../../src/password-management/application/forgot-password.use-case';
import { PasswordResetIssuer } from '../../src/password-management/application/password-reset-issuer';
import { ChangePasswordUseCase } from '../../src/password-management/application/change-password.use-case';
import { ResetPasswordUseCase } from '../../src/password-management/application/reset-password.use-case';
import { RevokeAccountSessionsUseCase } from '../../src/session-auth/application/revoke-account-sessions.use-case';
import { RefreshToken } from '../../src/session-auth/domain/refresh-token';
import { Session } from '../../src/session-auth/domain/session';
import { DomainError } from '../../src/shared-kernel/domain-error';
import { err, ok } from '../../src/shared-kernel/result';
import type { UnitOfWork } from '../../src/shared-kernel/unit-of-work';
import type { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { InMemoryAbuseCounterStore } from './in-memory-abuse-counter-store';
import { InMemoryAppRepository } from './in-memory-app.repository';
import { InMemoryEmailOutbox } from './in-memory-email-outbox';
import { InMemorySessionRepository } from './in-memory-session.repository';
import { FakePasswordHasher, InMemoryOneTimeTokenRepository, InMemoryUserRepository } from './in-memory-user-accounts';

export const START = new Date('2026-03-03T10:00:00.000Z');
export const SHOP_CLIENT_ID = 'app_shop';
export const BLOG_CLIENT_ID = 'app_blog';
export const SHOP_ORIGIN = 'https://shop.example';
export const BLOG_ORIGIN = 'https://blog.example';

export interface AccountsHarnessOptions {
  /** Abuse limits; defaults to the ADR 36 values. */
  policies?: PolicyTable;
}

function activeApp(id: string, clientId: string, name: string, origin: string): App {
  return App.restore({
    id,
    clientId,
    name,
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [origin],
    emailFrom: null,
    emailConfirmationUrl: `${origin}/confirm`,
    passwordResetUrl: `${origin}/reset`,
    status: 'active',
    createdAt: START,
    updatedAt: START,
  });
}

/** The three account use cases wired to in-memory ports, with two active apps. */
export async function accountsHarness(options: AccountsHarnessOptions = {}) {
  const clock = new FixedClock(START);
  const apps = new InMemoryAppRepository();
  const users = new InMemoryUserRepository();
  const oneTimeTokens = new InMemoryOneTimeTokenRepository((userId) => {
    const user = users.users.get(userId);
    const app = user === undefined ? undefined : [...apps.apps.values()].find((a) => a.id === user.appId);
    return app === undefined ? null : { appId: app.id, clientId: app.clientId };
  });
  const outbox = new InMemoryEmailOutbox();
  const hasher = new FakePasswordHasher();
  const sessions = new InMemorySessionRepository();
  /** How many units of work are open; the abuse store below refuses calls while it is above zero. */
  let uowDepth = 0;
  /** Runs the work and puts users, tokens and sessions back when it throws, like a rolled-back transaction. */
  const uow: UnitOfWork = {
    async run<T>(work: () => Promise<T>): Promise<T> {
      const restoreSessions = sessions.snapshot();
      const usersBefore = new Map(users.users);
      const tokensBefore = new Map(oneTimeTokens.tokens);
      const emailsBefore = new Map(outbox.emails);
      uowDepth += 1;
      try {
        return await work();
      } catch (error) {
        restoreSessions();
        users.users.clear();
        for (const [key, value] of usersBefore) users.users.set(key, value);
        oneTimeTokens.tokens.clear();
        for (const [key, value] of tokensBefore) oneTimeTokens.tokens.set(key, value);
        outbox.emails.clear();
        for (const [key, value] of emailsBefore) outbox.emails.set(key, value);
        throw error;
      } finally {
        uowDepth -= 1;
      }
    },
  };
  const revokeSessions = new RevokeAccountSessionsUseCase({ sessions, clock });
  const resolveClient = new ResolveClientUseCase(apps);
  const abuseStore = new InMemoryAbuseCounterStore();
  // The Postgres store runs on its own pool connection, so a counter call inside a unit of work can deadlock the
  // pool (C1). Every use case wired here fails loudly if it ever does that.
  for (const method of ['hit', 'reset'] as const) {
    const original = abuseStore[method].bind(abuseStore) as (...args: never[]) => Promise<unknown>;
    (abuseStore as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
      if (uowDepth > 0) throw new Error(`abuse counter ${method} called inside a unit of work`);
      return original(...args);
    };
  }
  const abuse = new AbuseGuard({ store: abuseStore, policies: options.policies ?? DEFAULT_POLICIES, clock });
  const tokenGenerator = new CryptoTokenGenerator();
  const confirmations = new ConfirmationIssuer({ tokens: tokenGenerator, oneTimeTokens, outbox, clock });
  const resets = new PasswordResetIssuer({ tokens: tokenGenerator, oneTimeTokens, outbox, clock });

  const buildReset = (revoke: { execute(input: { userId: string; reason: 'password_reset' }): Promise<number> }) =>
    new ResetPasswordUseCase({ resolveClient, abuse, oneTimeTokens, users, hasher, sessions: revoke, clock, uow });

  /**
   * Stands in for `AuthenticateBearerUseCase`: `Bearer fake:<userId>` is a valid token of that account, bound
   * to its app (and to the app's origin when the request has one); anything else is `unauthorized`.
   */
  const authenticate = {
    execute: async (input: { authorization: string | undefined; origin: string | undefined }) => {
      const unauthorized = () => err(new DomainError('unauthorized', 'Missing or invalid access token'));
      const stray = /^Bearer fake-app:([^:]+):(.+)$/.exec(input.authorization ?? '');
      if (stray !== null) return ok({ accountId: stray[2]!, appId: stray[1]!, clientId: SHOP_CLIENT_ID });
      const userId = /^Bearer fake:(.+)$/.exec(input.authorization ?? '')?.[1];
      const user = userId === undefined ? undefined : users.users.get(userId);
      const app = user === undefined ? undefined : [...apps.apps.values()].find((a) => a.id === user.appId);
      if (user === undefined || app === undefined) return unauthorized();
      if (input.origin !== undefined && !app.allowedOrigins.includes(input.origin)) return unauthorized();
      return ok({ accountId: user.id, appId: app.id, clientId: app.clientId });
    },
  };

  const buildChange = (revoke: { execute(input: { userId: string; reason: 'password_changed' }): Promise<number> }) =>
    new ChangePasswordUseCase({ resolveClient, abuse, authenticate, users, hasher, sessions: revoke, outbox, clock, uow });

  const shop = activeApp('11111111-1111-4111-8111-111111111111', SHOP_CLIENT_ID, 'Shop', SHOP_ORIGIN);
  const blog = activeApp('22222222-2222-4222-8222-222222222222', BLOG_CLIENT_ID, 'Blog', BLOG_ORIGIN);
  await apps.save(shop);
  await apps.save(blog);

  return {
    clock,
    apps,
    users,
    oneTimeTokens,
    outbox,
    hasher,
    shop,
    blog,
    abuseStore,
    /** A client address for use cases that take one. */
    ip: ClientIp.from('203.0.113.7', undefined),
    signup: new SignupUseCase({ resolveClient, abuse, users, hasher, confirmations, outbox, clock, uow }),
    confirm: new ConfirmEmailUseCase({ resolveClient, abuse, oneTimeTokens, users, outbox, clock, uow }),
    resend: new ResendConfirmationUseCase({ resolveClient, abuse, users, confirmations, uow }),
    forgot: new ForgotPasswordUseCase({ resolveClient, abuse, users, confirmations, resets, uow }),
    reset: buildReset(revokeSessions),
    change: buildChange(revokeSessions),
    /** A change use case over the same fakes with another revocation step, for tests that make it fail. */
    buildChange,
    /** The Authorization header of a valid fake access token for the account. */
    bearer: (user: { id: string }) => `Bearer fake:${user.id}`,
    /** A valid token whose account does not exist in the given app. */
    strayBearer: (appId: string, accountId: string) => `Bearer fake-app:${appId}:${accountId}`,
    /** A reset use case over the same fakes with another revocation step, for tests that make it fail. */
    buildReset,
    sessions,
    /** Opens an active session (one refresh token) for the account, like a login would. */
    openSession: async (user: { id: string; appId: string }) => {
      const session = Session.open({ id: crypto.randomUUID(), appId: user.appId, userId: user.id, now: clock.now(), absoluteTtlSeconds: 86_400 * 30 });
      await sessions.open(
        session,
        RefreshToken.issue({ tokenHash: tokenGenerator.generate().hash, session, now: clock.now(), idleTtlSeconds: 86_400 * 7 }),
      );
      return session.id;
    },
    /** A copy of the shop app with other email link URLs (null for a legacy app), saved and active. */
    addApp: async (clientId: string, urls: { emailConfirmationUrl: string | null; passwordResetUrl: string | null }) => {
      const app = App.restore({ ...shop, id: crypto.randomUUID(), clientId, ...urls });
      await apps.save(app);
      return app;
    },
    /** Emails queued so far, oldest first. */
    queued: (): OutboxEmail[] => [...outbox.emails.values()],
    /** The raw token inside the most recent queued confirmation email. */
    latestConfirmationToken: (): string => {
      const emails = [...outbox.emails.values()].filter((email) => email.template === 'confirmation');
      const token = emails.at(-1)?.payload['token'];
      if (token === undefined) throw new Error('no confirmation email was queued');
      return token;
    },
    /** The raw token inside the most recent queued password-reset email. */
    latestResetToken: (): string => {
      const emails = [...outbox.emails.values()].filter((email) => email.template === 'password-reset');
      const token = emails.at(-1)?.payload['token'];
      if (token === undefined) throw new Error('no password-reset email was queued');
      return token;
    },
  };
}
