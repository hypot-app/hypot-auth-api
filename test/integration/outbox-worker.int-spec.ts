import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { SystemClock } from '../../src/shared-kernel/clock';
import { OutboxWorker } from '../../src/transactional-email/application/outbox-worker';
import { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { EmailOutboxSchema } from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { FakeEmailSender } from '../support/fake-email-sender';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('OutboxWorker with Postgres (integration)', () => {
  let db: TestDatabase;
  let outbox: TypeOrmEmailOutbox;
  let appId: string;
  const logs: string[] = [];

  const workerWith = (sender: FakeEmailSender) =>
    new OutboxWorker({
      outbox,
      apps: new TypeOrmAppRepository(db.dataSource),
      sender,
      renderer: { render: async ({ template }) => ({ subject: template, text: 'body' }) },
      clock: new SystemClock(),
      defaultFrom: 'no-reply@auth.example',
      logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) },
      maxAttempts: 3,
    });

  const queue = (to: string, payload: Record<string, string> = {}) =>
    outbox.save(
      OutboxEmail.queue({ id: randomUUID(), appId, to, template: 'welcome', payload, now: new Date(Date.now() - 1000) }),
    );

  const rows = (): Promise<{ status: string; payload: unknown; locked_until: Date | null }[]> =>
    db.dataSource.query(`SELECT status, payload, locked_until FROM email_outbox ORDER BY to_address`);

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, EmailOutboxSchema] });
    outbox = new TypeOrmEmailOutbox(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    logs.length = 0;
    const now = new Date();
    appId = randomUUID();
    await new TypeOrmAppRepository(db.dataSource).save(
      App.restore({
        id: appId,
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
        createdAt: now,
        updatedAt: now,
      }),
    );
  });

  it('two workers running at once deliver each email exactly once', async () => {
    const senderA = new FakeEmailSender();
    const senderB = new FakeEmailSender();
    const recipients = Array.from({ length: 8 }, (_, i) => `user${i}@example.com`);
    for (const to of recipients) await queue(to);

    await Promise.all([workerWith(senderA).drain(100), workerWith(senderB).drain(100)]);

    const delivered = [...senderA.sent, ...senderB.sent].map((m) => m.to).sort();
    expect(delivered).toEqual(recipients);
    // Every row ends sent, payload purged and the lease released.
    expect(await rows()).toEqual(Array(8).fill({ status: 'sent', payload: {}, locked_until: null }));
  });
});
