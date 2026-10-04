import { App } from '../../app-registry/domain/app';
import { FixedClock } from '../../shared-kernel/clock';
import { FakeEmailSender } from '../../../test/support/fake-email-sender';
import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { InMemoryEmailOutbox } from '../../../test/support/in-memory-email-outbox';
import type { EmailTemplate } from '../domain/email-template';
import { OutboxEmail } from '../domain/outbox-email';
import type { TemplateRenderer } from '../domain/template-renderer';
import { EmailLinks } from './email-links';
import { LEASE_MS, OutboxWorker, retryDelayMs, type WorkerLogger } from './outbox-worker';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const TOKEN = 'T0kenSecretValue_0123456789abcdefghijklmnopq';
const MAIL_FROM = 'Auth <no-reply@auth.example>';

const clientIdOf = (id: string): string => `app_${id.padEnd(32, '0')}`;

const appWith = (id: string, emailFrom: string | null): App =>
  App.restore({
    id,
    clientId: clientIdOf(id),
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: [],
    emailFrom,
    postResetRedirectUri: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });

type RenderInput = Parameters<TemplateRenderer['render']>[0];

/** Records what it was asked to render; output is derived from the input so tests can see the wiring. */
class RecordingRenderer implements TemplateRenderer {
  readonly calls: RenderInput[] = [];
  failWith: Error | null = null;

  async render(input: RenderInput) {
    if (this.failWith) throw this.failWith;
    this.calls.push(input);
    return { subject: `subject:${input.template}`, text: `body:${input.variables['link'] ?? 'no-link'}` };
  }
}

function setup(options: { sendDeadlineMs?: number } = {}) {
  const outbox = new InMemoryEmailOutbox();
  const apps = new InMemoryAppRepository();
  const sender = new FakeEmailSender();
  const renderer = new RecordingRenderer();
  const clock = new FixedClock(NOW);
  const logs: string[] = [];
  const logger: WorkerLogger = { warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const worker = new OutboxWorker({
    outbox,
    apps,
    sender,
    renderer,
    clock,
    links: new EmailLinks('https://auth.example'),
    defaultFrom: MAIL_FROM,
    logger,
    maxAttempts: 3,
    ...options,
  });
  const enqueue = async (
    app: App,
    template: EmailTemplate,
    payload: Record<string, string> = {},
    to = 'ana@example.com',
  ) => {
    await apps.save(app);
    const email = OutboxEmail.queue({ id: `mail-${outbox.emails.size + 1}`, appId: app.id, to, template, payload, now: NOW });
    await outbox.save(email);
    return email;
  };
  return { outbox, apps, sender, renderer, clock, logs, worker, enqueue };
}

describe('retryDelayMs', () => {
  it('doubles from 30 seconds per attempt and caps at one hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(retryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000,
    ]);
  });
});

describe('OutboxWorker', () => {
  it('returns false and sends nothing when the outbox is empty or the only email is not due yet', async () => {
    const { worker, sender, enqueue, outbox, clock } = setup();
    expect(await worker.processNext()).toBe(false);

    const email = await enqueue(appWith('a1', null), 'welcome');
    outbox.emails.set(email.id, { ...email, nextAttemptAt: new Date(clock.now().getTime() + 60_000) });

    expect(await worker.processNext()).toBe(false);
    expect(sender.sent).toEqual([]);
    expect(outbox.emails.get(email.id)?.status).toBe('pending');
  });

  it('renders with the link variables, sends from MAIL_FROM, then marks sent and purges the payload', async () => {
    const { worker, sender, renderer, outbox, enqueue } = setup();
    const email = await enqueue(appWith('a1', null), 'confirmation', { token: TOKEN });

    expect(await worker.processNext()).toBe(true);

    expect(renderer.calls).toEqual([
      {
        template: 'confirmation',
        clientId: clientIdOf('a1'),
        variables: { appName: 'Shop', link: `https://auth.example/api/v1/accounts/confirm?token=${TOKEN}` },
      },
    ]);
    expect(sender.sent).toEqual([
      {
        to: 'ana@example.com',
        from: MAIL_FROM,
        subject: 'subject:confirmation',
        text: `body:https://auth.example/api/v1/accounts/confirm?token=${TOKEN}`,
      },
    ]);
    expect(outbox.emails.get(email.id)).toMatchObject({ status: 'sent', payload: {}, attempts: 1, lastError: null });
  });

  it('uses the app email_from over MAIL_FROM when the app sets one', async () => {
    const { worker, sender, enqueue } = setup();
    await enqueue(appWith('a1', 'Shop <hello@shop.example>'), 'welcome');
    await enqueue(appWith('a2', null), 'welcome');

    await worker.processNext();
    await worker.processNext();

    expect(sender.sent.map((m) => m.from)).toEqual(['Shop <hello@shop.example>', MAIL_FROM]);
  });

  it('drain sends due emails oldest first, up to the limit, and reports how many', async () => {
    const { worker, sender, enqueue, outbox } = setup();
    await enqueue(appWith('a1', null), 'welcome', {}, 'one@example.com');
    await enqueue(appWith('a2', null), 'welcome', {}, 'two@example.com');
    await enqueue(appWith('a3', null), 'welcome', {}, 'three@example.com');

    expect(await worker.drain(2)).toBe(2);
    expect(sender.sent.map((m) => m.to)).toEqual(['one@example.com', 'two@example.com']);
    expect(await worker.drain(10)).toBe(1);
    expect([...outbox.emails.values()].map((e) => e.status)).toEqual(['sent', 'sent', 'sent']);
  });

  describe('provider failure', () => {
    it('keeps the email pending with its payload, counts the attempt and backs off', async () => {
      const { worker, sender, outbox, enqueue, clock } = setup();
      const email = await enqueue(appWith('a1', null), 'confirmation', { token: TOKEN });
      sender.failWith = new Error('connect ECONNREFUSED 10.0.0.5:587');

      expect(await worker.processNext()).toBe(true);

      expect(outbox.emails.get(email.id)).toMatchObject({
        status: 'pending',
        payload: { token: TOKEN },
        attempts: 1,
        lastError: 'Error: connect ECONNREFUSED 10.0.0.5:587',
        nextAttemptAt: new Date(NOW.getTime() + retryDelayMs(1)),
      });
      // Not retried before the backoff elapses, retried after.
      expect(await worker.processNext()).toBe(false);
      clock.advanceMs(retryDelayMs(1));
      sender.failWith = null;
      expect(await worker.processNext()).toBe(true);
      expect(outbox.emails.get(email.id)).toMatchObject({ status: 'sent', attempts: 2, payload: {} });
    });

    it('never stores or logs the token or the recipient echoed by the provider', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'confirmation', { token: TOKEN }, 'ana@example.com');
      sender.failWith = new Error(`550 rejected ana@example.com link ?token=${TOKEN} refused`);

      await worker.processNext();

      const stored = outbox.emails.get(email.id)?.lastError;
      expect(stored).toBe('Error: 550 rejected [redacted] link ?token=[redacted] refused');
      expect(logs).toHaveLength(1);
      for (const text of [stored ?? '', ...logs]) {
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain('ana@example.com');
      }
    });

    it('masks a recipient echoed with different letter case', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome', {}, 'Ana.Lopez@Example.com');
      sender.failWith = new Error('550 <ANA.LOPEZ@EXAMPLE.COM> rejected, ana.lopez@example.com unknown');

      await worker.processNext();

      expect(outbox.emails.get(email.id)?.lastError).toBe('Error: 550 <[redacted]> rejected, [redacted] unknown');
      expect(logs.join(' ').toLowerCase()).not.toContain('ana.lopez');
    });

    it('bounds a very long provider message in both the stored error and the log', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      sender.failWith = new Error('x'.repeat(10_000));

      await worker.processNext();

      expect(outbox.emails.get(email.id)?.lastError).toHaveLength(500);
      expect(logs[0]?.length).toBeLessThan(700);
    });

    it('gives up after maxAttempts: failed, payload purged, error logged', async () => {
      const { worker, sender, outbox, enqueue, clock, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'confirmation', { token: TOKEN });
      sender.failWith = new Error('timeout');

      for (let attempt = 1; attempt <= 3; attempt++) {
        expect(await worker.processNext()).toBe(true);
        clock.advanceMs(retryDelayMs(attempt));
      }

      expect(outbox.emails.get(email.id)).toMatchObject({
        status: 'failed',
        payload: {},
        attempts: 3,
        lastError: 'Error: timeout',
      });
      expect(logs.at(-1)).toBe(`email ${email.id} (confirmation) attempt 3/3 failed, giving up: Error: timeout`);
      expect(await worker.processNext()).toBe(false);
    });

    it('treats a render error like a delivery failure and sends nothing', async () => {
      const { worker, sender, renderer, outbox, enqueue } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      renderer.failWith = new Error('template missing');

      await worker.processNext();

      expect(sender.sent).toEqual([]);
      expect(outbox.emails.get(email.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'Error: template missing',
      });
    });

    it('stores a non-Error throw as a generic message, never its content', async () => {
      const { worker, sender, outbox, enqueue } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      sender.failWith = `plain string with ${TOKEN}`;

      await worker.processNext();

      expect(outbox.emails.get(email.id)?.lastError).toBe('unknown error');
    });
  });

  describe('lease', () => {
    it('claims under a lease and releases it when the outcome is stored', async () => {
      const { worker, outbox, enqueue, sender } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      let leaseDuringSend: Date | null = null;
      sender.send = async () => {
        leaseDuringSend = outbox.emails.get(email.id)?.lockedUntil ?? null;
      };

      await worker.processNext();

      expect(leaseDuringSend).toEqual(new Date(NOW.getTime() + LEASE_MS));
      expect(outbox.emails.get(email.id)).toMatchObject({ status: 'sent', lockedUntil: null });
    });

    it('aborts a send that hangs past the deadline and schedules a retry', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup({ sendDeadlineMs: 20 });
      const email = await enqueue(appWith('a1', null), 'confirmation', { token: TOKEN });
      sender.send = () => new Promise<void>(() => undefined);

      expect(await worker.processNext()).toBe(true);

      expect(outbox.emails.get(email.id)).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastError: 'Error: send exceeded the 20 ms deadline',
        payload: { token: TOKEN },
        lockedUntil: null,
        nextAttemptAt: new Date(NOW.getTime() + retryDelayMs(1)),
      });
      expect(logs).toHaveLength(1);
    });

    it('discards the outcome when the lease was lost to another worker mid-send', async () => {
      const { worker, sender, outbox, enqueue, clock, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      sender.send = async () => {
        // The send outlives the lease, another worker re-claims the row.
        clock.advanceMs(LEASE_MS + 1);
        await outbox.claimNextDue(clock.now(), LEASE_MS);
      };

      expect(await worker.processNext()).toBe(true);

      const row = outbox.emails.get(email.id);
      expect(row).toMatchObject({ status: 'pending', attempts: 0 });
      expect(row?.lockedUntil).toEqual(new Date(NOW.getTime() + 2 * LEASE_MS + 1));
      expect(logs).toEqual([`email ${email.id} (welcome) lease lost before the outcome was stored, outcome discarded`]);
    });
  });

  describe('permanent failures (no retry, nothing sent)', () => {
    it('unknown template', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      outbox.emails.set(email.id, { ...email, template: 'newsletter', payload: { token: TOKEN } });

      expect(await worker.processNext()).toBe(true);

      expect(sender.sent).toEqual([]);
      expect(outbox.emails.get(email.id)).toMatchObject({ status: 'failed', payload: {}, lastError: 'unknown template' });
      expect(logs).toEqual([`email ${email.id} (newsletter) failed permanently: unknown template`]);
    });

    it('invalid payload, without echoing the payload', async () => {
      const { worker, sender, outbox, enqueue, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'confirmation', { token: 'short' });

      await worker.processNext();

      expect(sender.sent).toEqual([]);
      expect(outbox.emails.get(email.id)).toMatchObject({
        status: 'failed',
        payload: {},
        lastError: 'invalid payload for template confirmation',
      });
      expect(logs.join('\n')).not.toContain('short');
    });

    it('app no longer exists', async () => {
      const { worker, sender, outbox, enqueue, apps, logs } = setup();
      const email = await enqueue(appWith('a1', null), 'welcome');
      apps.apps.clear();

      await worker.processNext();

      expect(sender.sent).toEqual([]);
      expect(outbox.emails.get(email.id)).toMatchObject({ status: 'failed', lastError: 'app not found' });
      expect(logs).toEqual([`email ${email.id} (welcome) failed permanently: app not found`]);
    });
  });
});
