import { SmtpEmailSender } from '../../src/transactional-email/infrastructure/smtp-email-sender';
import { startMailpit, type TestMailpit } from '../support/mailpit';

const SMTP_PASS = 'S3cr3tSmtpPassw0rd';

describe('SmtpEmailSender (integration, Mailpit)', () => {
  let mailpit: TestMailpit;

  const senderFor = (overrides: Partial<ConstructorParameters<typeof SmtpEmailSender>[0]> = {}) =>
    new SmtpEmailSender({ ...mailpit.smtp, secure: false, auth: undefined, ...overrides });

  beforeAll(async () => {
    mailpit = await startMailpit();
  }, 180_000);

  afterAll(async () => {
    await mailpit?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await mailpit.clear();
  });

  it('delivers the message: recipient, sender (including a display name), subject and text arrive intact', async () => {
    await senderFor().send({
      to: 'ana@example.com',
      from: 'Shop <hello@shop.example>',
      subject: 'Confirm your email',
      text: 'Open https://auth.example/api/v1/accounts/confirm?token=abc&x=1',
    });

    const [message] = await mailpit.messages();
    expect(message).toMatchObject({
      from: { name: 'Shop', address: 'hello@shop.example' },
      to: [{ address: 'ana@example.com' }],
      subject: 'Confirm your email',
    });
    expect(message?.text.trim()).toBe('Open https://auth.example/api/v1/accounts/confirm?token=abc&x=1');
  });

  it('refuses to send credentials over a connection that offers no STARTTLS, and delivers nothing', async () => {
    // Mailpit here has no TLS, which is what a STARTTLS-stripping attacker looks like from the client.
    const sender = senderFor({ auth: { user: 'smtp-user', pass: SMTP_PASS } });

    const failure = await sender
      .send({ to: 'ana@example.com', from: 'no-reply@auth.example', subject: 'with auth', text: 'x' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toMatchObject({ message: expect.stringMatching(/STARTTLS/i) });
    expect(await mailpit.messages()).toEqual([]);
  });

  it('sends to exactly one address: a list or an injected header is refused and nothing is delivered', async () => {
    const sender = senderFor();
    for (const to of ['a@example.com, b@example.com', 'a@example.com\r\nBcc: evil@example.com', 'Ana <a@example.com>', '']) {
      await expect(sender.send({ to, from: 'no-reply@auth.example', subject: 's', text: 't' })).rejects.toThrow(
        'invalid recipient',
      );
    }
    expect(await mailpit.messages()).toEqual([]);
  });

  it('on a connection failure rejects with the network error and neither logs nor leaks the password', async () => {
    const consoleCalls = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
    );
    try {
      const unreachable = senderFor({ port: 1, auth: { user: 'smtp-user', pass: SMTP_PASS } });

      const failure = await unreachable
        .send({ to: 'ana@example.com', from: 'no-reply@auth.example', subject: 's', text: 't' })
        .then(
          () => null,
          (error: unknown) => error,
        );

      // Jest runs tests in a separate realm, so `instanceof Error` is not reliable here.
      expect(failure).toMatchObject({ code: 'ESOCKET', message: expect.stringMatching(/ECONNREFUSED/) });
      expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain(SMTP_PASS);
      for (const spy of consoleCalls) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of consoleCalls) spy.mockRestore();
    }
  });
});
