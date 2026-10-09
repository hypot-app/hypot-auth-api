import type { INestApplication } from '@nestjs/common';
import { AbuseCounterSweeper } from '../../src/abuse-protection/application/abuse-counter-sweeper';
import { startBackgroundJobs } from '../../src/background-jobs';
import { RetentionSweeper } from '../../src/platform/retention/retention-sweeper';
import { OutboxPoller } from '../../src/transactional-email/infrastructure/outbox-poller';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('background jobs wiring (e2e, 19.5)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  const starts = {
    outbox: jest.spyOn(OutboxPoller.prototype, 'start'),
    abuse: jest.spyOn(AbuseCounterSweeper.prototype, 'start'),
    retention: jest.spyOn(RetentionSweeper.prototype, 'start'),
  };
  const stops = jest.spyOn(RetentionSweeper.prototype, 'onModuleDestroy');

  beforeAll(async () => {
    db = await startTestDatabase();
    // Replace the real start with a no-op: this test checks who calls it, and must not leave timers behind.
    for (const spy of Object.values(starts)) spy.mockImplementation(() => undefined);
    app = await createTestApp({ databaseUrl: db.url });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
    jest.restoreAllMocks();
  }, 60_000);

  it('starts no job when the test factory builds the app, although all three exist in it', () => {
    expect(app.get(OutboxPoller)).toBeInstanceOf(OutboxPoller);
    expect(app.get(AbuseCounterSweeper)).toBeInstanceOf(AbuseCounterSweeper);
    expect(app.get(RetentionSweeper)).toBeInstanceOf(RetentionSweeper);
    expect(starts.outbox).not.toHaveBeenCalled();
    expect(starts.abuse).not.toHaveBeenCalled();
    expect(starts.retention).not.toHaveBeenCalled();
  });

  it('starts all three when main.ts calls startBackgroundJobs on the real application', () => {
    startBackgroundJobs(app);

    expect(starts.outbox).toHaveBeenCalledTimes(1);
    expect(starts.abuse).toHaveBeenCalledTimes(1);
    expect(starts.retention).toHaveBeenCalledTimes(1);
  });

  it('stops the retention sweeper on shutdown, before the database closes', async () => {
    await app.close();

    expect(stops).toHaveBeenCalledTimes(1);
  });
});
