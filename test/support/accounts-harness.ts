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
import type { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { InMemoryAbuseCounterStore } from './in-memory-abuse-counter-store';
import { InMemoryAppRepository, PassThroughUnitOfWork } from './in-memory-app.repository';
import { InMemoryEmailOutbox } from './in-memory-email-outbox';
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
  const uow = new PassThroughUnitOfWork();
  const resolveClient = new ResolveClientUseCase(apps);
  const abuseStore = new InMemoryAbuseCounterStore();
  const abuse = new AbuseGuard({ store: abuseStore, policies: options.policies ?? DEFAULT_POLICIES, clock });
  const confirmations = new ConfirmationIssuer({ tokens: new CryptoTokenGenerator(), oneTimeTokens, outbox, clock });

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
  };
}
