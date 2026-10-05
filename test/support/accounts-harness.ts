import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { App } from '../../src/app-registry/domain/app';
import { FixedClock } from '../../src/shared-kernel/clock';
import { CryptoTokenGenerator } from '../../src/shared-kernel/token-generator';
import { ConfirmEmailUseCase } from '../../src/user-accounts/application/confirm-email.use-case';
import { ConfirmationIssuer } from '../../src/user-accounts/application/confirmation-issuer';
import { ResendConfirmationUseCase } from '../../src/user-accounts/application/resend-confirmation.use-case';
import { SignupUseCase } from '../../src/user-accounts/application/signup.use-case';
import type { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { InMemoryAppRepository, PassThroughUnitOfWork } from './in-memory-app.repository';
import { InMemoryEmailOutbox } from './in-memory-email-outbox';
import { FakePasswordHasher, InMemoryOneTimeTokenRepository, InMemoryUserRepository } from './in-memory-user-accounts';

export const START = new Date('2026-03-03T10:00:00.000Z');
export const SHOP_CLIENT_ID = 'app_shop';

/** The three account use cases wired to in-memory ports, with one active app. */
export async function accountsHarness() {
  const clock = new FixedClock(START);
  const apps = new InMemoryAppRepository();
  const users = new InMemoryUserRepository();
  const oneTimeTokens = new InMemoryOneTimeTokenRepository();
  const outbox = new InMemoryEmailOutbox();
  const hasher = new FakePasswordHasher();
  const uow = new PassThroughUnitOfWork();
  const resolveClient = new ResolveClientUseCase(apps);
  const confirmations = new ConfirmationIssuer({ tokens: new CryptoTokenGenerator(), oneTimeTokens, outbox, clock });

  const shop = App.restore({
    id: '11111111-1111-4111-8111-111111111111',
    clientId: SHOP_CLIENT_ID,
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [],
    emailFrom: null,
    emailConfirmationUrl: null,
    passwordResetUrl: null,
    status: 'active',
    createdAt: START,
    updatedAt: START,
  });
  await apps.save(shop);

  return {
    clock,
    apps,
    users,
    oneTimeTokens,
    outbox,
    hasher,
    shop,
    signup: new SignupUseCase({ resolveClient, users, hasher, confirmations, outbox, clock, uow }),
    confirm: new ConfirmEmailUseCase({ oneTimeTokens, users, outbox, clock, uow }),
    resend: new ResendConfirmationUseCase({ resolveClient, users, confirmations, uow }),
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
