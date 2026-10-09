import { AbuseCounterSweeper } from './abuse-protection/application/abuse-counter-sweeper';
import { startBackgroundJobs, type JobHost } from './background-jobs';
import { RetentionSweeper } from './platform/retention/retention-sweeper';
import { OutboxPoller } from './transactional-email/infrastructure/outbox-poller';

describe('startBackgroundJobs (what main.ts starts)', () => {
  const jobs = [OutboxPoller, AbuseCounterSweeper, RetentionSweeper] as const;

  function fakeApp() {
    const started = new Map<unknown, jest.Mock>();
    for (const job of jobs) started.set(job, jest.fn());
    const get = jest.fn((token: unknown) => ({ start: started.get(token) ?? jest.fn() }));
    return { app: { get } as unknown as JobHost, get, started };
  }

  it.each(jobs.map((job) => [job.name, job] as const))('starts the %s exactly once', (_name, job) => {
    const { app, started } = fakeApp();

    startBackgroundJobs(app);

    expect(started.get(job)).toHaveBeenCalledTimes(1);
  });

  it('asks the application for the three jobs and nothing else', () => {
    const { app, get } = fakeApp();

    startBackgroundJobs(app);

    expect(get.mock.calls.map(([token]) => token)).toEqual([...jobs]);
  });
});
