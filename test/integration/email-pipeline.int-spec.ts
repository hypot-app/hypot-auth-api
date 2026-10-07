import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { OutboxWorker } from '../../src/transactional-email/application/outbox-worker';
import { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { createTestApp } from '../support/create-test-app';
import { startMailpit, type TestMailpit } from '../support/mailpit';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const BASE_URL = 'https://auth.example.test';
const CONFIRM_URL = 'https://shop.example/confirm?lang=en';
const RESET_URL = 'https://shop.example/reset';
const TOKEN = 'Tok3n_0123456789abcdefghijklmnopqrstuvwxyzAB';

/** The whole path: Postgres outbox -> worker -> Handlebars default templates -> SMTP -> Mailpit. */
describe('email pipeline (integration, Postgres + Mailpit)', () => {
  let db: TestDatabase;
  let mailpit: TestMailpit;
  let app: INestApplication;

  const createApp = async (emailFrom: string | null): Promise<App> => {
    const now = new Date();
    const created = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [],
      emailFrom,
      emailConfirmationUrl: CONFIRM_URL,
      passwordResetUrl: RESET_URL,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await new TypeOrmAppRepository(app.get(DataSource)).save(created);
    return created;
  };

  const queue = (appId: string, template: Parameters<typeof OutboxEmail.queue>[0]['template'], to: string, payload = {}) =>
    app.get(TypeOrmEmailOutbox).save(
      OutboxEmail.queue({ id: randomUUID(), appId, to, template, payload, now: new Date(Date.now() - 1000) }),
    );

  beforeAll(async () => {
    [db, mailpit] = await Promise.all([startTestDatabase({ entities: [AppSchema] }), startMailpit()]);
    app = await createTestApp({
      databaseUrl: db.url,
      config: {
        authPublicBaseUrl: BASE_URL,
        mailFrom: 'Auth <no-reply@auth.example.test>',
        smtp: { ...mailpit.smtp, secure: false, auth: undefined },
      },
    });
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await Promise.all([db?.teardown(), mailpit?.teardown()]);
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    await mailpit.clear();
  });

  it('delivers queued emails with links on the app URLs and the per-app from override', async () => {
    const plain = await createApp(null);
    const branded = await createApp('Shop <hello@shop.example>');
    await queue(plain.id, 'confirmation', 'ana@example.com', { token: TOKEN });
    await queue(branded.id, 'password-reset', 'bo@example.com', { token: TOKEN });
    await queue(branded.id, 'account-exists', 'cy@example.com');

    expect(await app.get(OutboxWorker).drain(10)).toBe(3);

    const byRecipient = new Map((await mailpit.messages()).map((m) => [m.to[0]?.address, m]));
    const confirmation = byRecipient.get('ana@example.com');
    expect(confirmation?.from).toEqual({ name: 'Auth', address: 'no-reply@auth.example.test' });
    expect(confirmation?.subject).toBe('Confirm your email for Shop');
    expect(confirmation?.text).toContain(`${CONFIRM_URL}#token=${TOKEN}`);

    const reset = byRecipient.get('bo@example.com');
    expect(reset?.from).toEqual({ name: 'Shop', address: 'hello@shop.example' });
    expect(reset?.text).toContain(`${RESET_URL}#token=${TOKEN}`);

    const exists = byRecipient.get('cy@example.com');
    expect(exists?.text.match(/https?:\/\/\S+/g)).toEqual([RESET_URL]);
    expect(exists?.text).not.toContain('token');
    expect(exists?.text).not.toContain('#');
    for (const message of byRecipient.values()) expect(message.text).not.toContain(BASE_URL);

    const rows: { status: string; payload: unknown }[] = await db.dataSource.query(`SELECT status, payload FROM email_outbox`);
    expect(rows).toEqual(Array(3).fill({ status: 'sent', payload: {} }));
  });
});
