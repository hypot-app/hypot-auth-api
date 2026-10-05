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
const LEASE_SECONDS = 120;
const LEASE_MS = LEASE_SECONDS * 1000;

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
    const rows: { payload: unknown; status: string; attempts: number; locked_until: Date | null }[] =
      await db.dataSource.query(`SELECT payload, status, attempts, locked_until FROM email_outbox WHERE id = $1`, [id]);
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

  it('saves a queued email and claims it back, now holding a lease', async () => {
    const queued = email(at(0));
    await outbox.save(queued);

    const claimed = await outbox.claimNextDue(at(1), LEASE_MS);
    expect(claimed).toEqual({ ...queued, lockedUntil: at(1 + LEASE_SECONDS) });
  });

  it('claims the oldest due email first and ignores future, sent and failed ones', async () => {
    const older = email(at(1));
    const newer = email(at(2));
    await outbox.save(newer);
    await outbox.save(older);
    await outbox.save(email(at(500))); // not due yet
    await outbox.save(OutboxEmail.markSent(email(at(0)))); // already sent
    await outbox.save(OutboxEmail.markFailed(email(at(0)), 'gave up')); // dead

    const first = await outbox.claimNextDue(at(10), LEASE_MS);
    expect(first?.id).toBe(older.id);
    // The first is leased, so the next claim skips it even though it is still pending.
    expect((await outbox.claimNextDue(at(10), LEASE_MS))?.id).toBe(newer.id);
    expect(await outbox.claimNextDue(at(10), LEASE_MS)).toBeNull();
  });

  it('re-claims a row whose lease has expired, and not before', async () => {
    await outbox.save(email(at(0)));
    const first = await outbox.claimNextDue(at(1), LEASE_MS);

    expect(await outbox.claimNextDue(at(1 + LEASE_SECONDS - 1), LEASE_MS)).toBeNull();
    const second = await outbox.claimNextDue(at(1 + LEASE_SECONDS + 1), LEASE_MS);
    expect(second?.id).toBe(first?.id);
    expect(second?.lockedUntil).toEqual(at(1 + LEASE_SECONDS + 1 + LEASE_SECONDS));
  });

  it('complete stores the outcome and clears the lease', async () => {
    await outbox.save(email(at(0)));
    const claimed = (await outbox.claimNextDue(at(1), LEASE_MS)) as OutboxEmail;

    expect(await outbox.complete(OutboxEmail.markSent(claimed))).toBe(true);

    expect(await rawRow(claimed.id)).toEqual({ payload: {}, status: 'sent', attempts: 1, locked_until: null });
  });

  it('complete with a stale lease changes nothing: another worker re-claimed the row', async () => {
    await outbox.save(email(at(0)));
    const stale = (await outbox.claimNextDue(at(1), LEASE_MS)) as OutboxEmail;
    // Lease expires; a second worker claims the same row.
    const current = (await outbox.claimNextDue(at(1 + LEASE_SECONDS + 1), LEASE_MS)) as OutboxEmail;

    expect(await outbox.complete(OutboxEmail.markSent(stale))).toBe(false);
    expect(await rawRow(stale.id)).toMatchObject({ status: 'pending', attempts: 0, payload: { token: 'raw-token' } });

    expect(await outbox.complete(OutboxEmail.markSent(current))).toBe(true);
    expect(await rawRow(stale.id)).toMatchObject({ status: 'sent', locked_until: null });
  });

  it('joins the unit of work: a rollback discards the enqueue', async () => {
    const queued = email(at(0));
    await expect(
      uow.run(async () => {
        await outbox.save(queued);
        throw new Error('signup failed');
      }),
    ).rejects.toThrow('signup failed');

    expect(await outbox.claimNextDue(at(10), LEASE_MS)).toBeNull();
  });
});
