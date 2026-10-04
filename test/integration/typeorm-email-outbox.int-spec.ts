import { randomUUID } from 'node:crypto';
import { App } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { OutboxEmail } from '../../src/transactional-email/domain/outbox-email';
import { EmailOutboxSchema } from '../../src/transactional-email/infrastructure/persistence/email-outbox.schema';
import { TypeOrmEmailOutbox } from '../../src/transactional-email/infrastructure/persistence/typeorm-email-outbox';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('TypeOrmEmailOutbox (integration)', () => {
  let db: TestDatabase;
  let outbox: TypeOrmEmailOutbox;
  let uow: TypeOrmUnitOfWork;
  let appId: string;

  const email = (dueAt: Date, overrides: Partial<OutboxEmail> = {}): OutboxEmail => ({
    ...OutboxEmail.queue({
      id: randomUUID(),
      appId,
      to: 'ana@example.com',
      template: 'confirmation',
      payload: { token: 'raw-token' },
      now: dueAt,
    }),
    ...overrides,
  });

  const rawRow = async (id: string) => {
    const rows: { payload: unknown; status: string }[] = await db.dataSource.query(
      `SELECT payload, status FROM email_outbox WHERE id = $1`,
      [id],
    );
    return rows[0];
  };

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema, EmailOutboxSchema] });
    outbox = new TypeOrmEmailOutbox(db.dataSource);
    uow = new TypeOrmUnitOfWork(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
    const app = App.restore({
      id: randomUUID(),
      clientId: `app_${randomUUID().replaceAll('-', '')}`,
      name: 'Shop',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: [],
      allowedOrigins: [],
      emailFrom: null,
      postResetRedirectUri: null,
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    });
    await new TypeOrmAppRepository(db.dataSource).save(app);
    appId = app.id;
  });

  it('saves a queued email and claims it back as a domain value', async () => {
    const queued = email(at(0));
    await outbox.save(queued);

    const claimed = await uow.run(() => outbox.claimNextDue(at(1)));
    expect(claimed).toEqual(queued);
  });

  it('claims the oldest due email first and ignores future, sent and failed ones', async () => {
    const older = email(at(1));
    const newer = email(at(2));
    await outbox.save(newer);
    await outbox.save(older);
    await outbox.save(email(at(500))); // not due yet
    await outbox.save(OutboxEmail.markSent(email(at(0)))); // already sent
    await outbox.save(OutboxEmail.markFailed(email(at(0)), 'gave up')); // dead

    expect((await uow.run(() => outbox.claimNextDue(at(10))))?.id).toBe(older.id);
    await outbox.save(OutboxEmail.markSent(older));
    expect((await uow.run(() => outbox.claimNextDue(at(10))))?.id).toBe(newer.id);
    await outbox.save(OutboxEmail.markSent(newer));
    expect(await uow.run(() => outbox.claimNextDue(at(10)))).toBeNull();
  });

  it('persists a purged payload as an empty object', async () => {
    const queued = email(at(0));
    await outbox.save(queued);
    expect((await rawRow(queued.id)).payload).toEqual({ token: 'raw-token' });

    await outbox.save(OutboxEmail.markSent(queued));
    expect(await rawRow(queued.id)).toEqual({ payload: {}, status: 'sent' });
  });

  it('skips an email another worker holds locked', async () => {
    const first = email(at(1));
    const second = email(at(2));
    await outbox.save(first);
    await outbox.save(second);

    // Worker A claims the first email and keeps its transaction open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstClaimed!: (email: OutboxEmail | null) => void;
    const claimedByA = new Promise<OutboxEmail | null>((resolve) => (firstClaimed = resolve));
    const workerA = uow.run(async () => {
      firstClaimed(await outbox.claimNextDue(at(10)));
      await held;
    });
    expect((await claimedByA)?.id).toBe(first.id);

    // Worker B runs in its own transaction while A still holds the lock.
    const claimedByB = await uow.run(() => outbox.claimNextDue(at(10)));
    release();
    await workerA;

    expect(claimedByB?.id).toBe(second.id);
  });

  it('joins the unit of work: a rollback discards the enqueue', async () => {
    const queued = email(at(0));
    await expect(
      uow.run(async () => {
        await outbox.save(queued);
        throw new Error('signup failed');
      }),
    ).rejects.toThrow('signup failed');

    expect(await uow.run(() => outbox.claimNextDue(at(10)))).toBeNull();
  });
});
