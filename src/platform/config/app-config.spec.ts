import { ConfigError, loadConfig } from './app-config';

const validEnv = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  AUTH_PUBLIC_BASE_URL: 'https://auth.example.com',
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'no-reply@example.com',
};

describe('loadConfig', () => {
  it('applies defaults for optional settings', () => {
    const config = loadConfig(validEnv);
    expect(config).toEqual({
      nodeEnv: 'development',
      isProduction: false,
      port: 3000,
      databaseUrl: 'postgres://u:p@localhost:5432/db',
      authPublicBaseUrl: 'https://auth.example.com',
      smtp: { host: 'smtp.example.com', port: 587, secure: false, auth: undefined },
      mailFrom: 'no-reply@example.com',
    });
  });

  it('parses explicit values', () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: 'production',
      PORT: '8080',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer',
      SMTP_PASS: 's3cret',
    });
    expect(config.isProduction).toBe(true);
    expect(config.port).toBe(8080);
    expect(config.smtp).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'mailer', pass: 's3cret' },
    });
  });

  it.each(['DATABASE_URL', 'AUTH_PUBLIC_BASE_URL', 'SMTP_HOST', 'MAIL_FROM'])(
    'fails fast when %s is missing',
    (key) => {
      const env: Record<string, string | undefined> = { ...validEnv };
      delete env[key];
      expect(() => loadConfig(env)).toThrow(ConfigError);
      expect(() => loadConfig(env)).toThrow(key);
    },
  );

  it.each([
    ['not a url', 'auth.example.com'],
    ['a non-http scheme', 'ftp://auth.example.com'],
    ['a trailing slash', 'https://auth.example.com/'],
  ])('rejects AUTH_PUBLIC_BASE_URL with %s', (_label, value) => {
    expect(() => loadConfig({ ...validEnv, AUTH_PUBLIC_BASE_URL: value })).toThrow('AUTH_PUBLIC_BASE_URL');
  });

  it('accepts an http base URL with a port and path prefix', () => {
    const config = loadConfig({ ...validEnv, AUTH_PUBLIC_BASE_URL: 'http://localhost:3000' });
    expect(config.authPublicBaseUrl).toBe('http://localhost:3000');
  });

  it('rejects an unknown NODE_ENV and a non-numeric PORT', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'staging' })).toThrow('NODE_ENV');
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrow('PORT');
  });

  it('rejects an invalid SMTP_SECURE', () => {
    expect(() => loadConfig({ ...validEnv, SMTP_SECURE: 'yes' })).toThrow('SMTP_SECURE');
  });

  it.each([
    ['SMTP_USER only', { SMTP_USER: 'mailer' }],
    ['SMTP_PASS only', { SMTP_PASS: 's3cret' }],
  ])('requires SMTP_USER and SMTP_PASS together (%s)', (_label, extra) => {
    expect(() => loadConfig({ ...validEnv, ...extra })).toThrow('SMTP_USER and SMTP_PASS');
  });

  it('never leaks secret values in the error message', () => {
    let message = '';
    try {
      loadConfig({ ...validEnv, SMTP_PASS: 'super-secret-value', PORT: 'abc' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PORT');
    expect(message).not.toContain('super-secret-value');
  });

  it('never leaks DATABASE_URL credentials when the config is invalid', () => {
    const url = 'postgres://admin:db-secret-pw@db.internal:5432/auth';
    const messages = [{ PORT: 'abc' }, { DATABASE_URL: '' }].map((override) => {
      try {
        loadConfig({ ...validEnv, DATABASE_URL: url, ...override });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    });
    expect(messages[0]).toContain('PORT');
    expect(messages[1]).toContain('DATABASE_URL');
    for (const message of messages) {
      expect(message).not.toContain('db-secret-pw');
      expect(message).not.toContain('admin');
    }
  });

  it('never leaks the SMTP_USER value when SMTP_PASS is missing', () => {
    let message = '';
    try {
      loadConfig({ ...validEnv, SMTP_USER: 'mailer-secret-user' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SMTP_USER and SMTP_PASS');
    expect(message).not.toContain('mailer-secret-user');
  });
});
