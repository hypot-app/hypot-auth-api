import { buildTransportOptions, type SmtpSettings } from './smtp-email-sender';

const settings = (overrides: Partial<SmtpSettings> = {}): SmtpSettings => ({
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  auth: undefined,
  ...overrides,
});

describe('buildTransportOptions', () => {
  it('requires STARTTLS when credentials are sent over a non-implicit-TLS connection, so a downgrade cannot expose them', () => {
    const options = buildTransportOptions(settings({ auth: { user: 'u', pass: 'p' } }));

    expect(options).toMatchObject({ secure: false, requireTLS: true, auth: { user: 'u', pass: 'p' } });
  });

  it('does not force TLS without credentials (local Mailpit speaks plain SMTP)', () => {
    const options = buildTransportOptions(settings());

    expect(options.requireTLS).toBeFalsy();
    expect(options).not.toHaveProperty('auth');
  });

  it('does not need requireTLS under implicit TLS: the connection is encrypted from the start', () => {
    const options = buildTransportOptions(settings({ port: 465, secure: true, auth: { user: 'u', pass: 'p' } }));

    expect(options).toMatchObject({ secure: true });
    expect(options.requireTLS).toBeFalsy();
  });

  it('bounds connection, greeting and socket inactivity', () => {
    expect(buildTransportOptions(settings())).toMatchObject({
      connectionTimeout: expect.any(Number),
      greetingTimeout: expect.any(Number),
      socketTimeout: expect.any(Number),
    });
  });
});
