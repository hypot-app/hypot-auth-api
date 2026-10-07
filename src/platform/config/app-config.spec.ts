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
      trustProxy: false,
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

  describe('AUTH_PUBLIC_BASE_URL in production', () => {
    it.each(['http://auth.example.com', 'http://localhost:3000', 'http://auth.example.com:8080/prefix'])(
      'rejects %s',
      (value) => {
        const env = { ...validEnv, NODE_ENV: 'production', AUTH_PUBLIC_BASE_URL: value };
        expect(() => loadConfig(env)).toThrow(ConfigError);
        expect(() => loadConfig(env)).toThrow('AUTH_PUBLIC_BASE_URL: must be an https URL in production');
      },
    );

    it('rejects a mixed-case scheme in every environment', () => {
      const env = { ...validEnv, NODE_ENV: 'production', AUTH_PUBLIC_BASE_URL: 'HTTPS://auth.example.com' };
      expect(() => loadConfig(env)).toThrow('AUTH_PUBLIC_BASE_URL: must be an absolute http(s) URL');
    });

    it('accepts an https URL', () => {
      const config = loadConfig({ ...validEnv, NODE_ENV: 'production' });
      expect(config.authPublicBaseUrl).toBe('https://auth.example.com');
    });

    it.each(['development', 'test'])('accepts an http URL when NODE_ENV is %s', (nodeEnv) => {
      const config = loadConfig({
        ...validEnv,
        NODE_ENV: nodeEnv,
        AUTH_PUBLIC_BASE_URL: 'http://localhost:3000',
      });
      expect(config.authPublicBaseUrl).toBe('http://localhost:3000');
    });
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

  describe('signing keys (W2: owned by the token-lifecycle key store, not by config)', () => {
    it('loads without any signing key variable, so the operator CLI never needs the key set', () => {
      expect(() => loadConfig(validEnv)).not.toThrow();
    });

    it('does not retain the raw signing key secret', () => {
      const config = loadConfig({ ...validEnv, AUTH_SIGNING_KEYS: 'PRIVATE-KEY-MARKER', AUTH_SIGNING_KEYS_FILE: 'x' });

      expect(JSON.stringify(config)).not.toContain('PRIVATE-KEY-MARKER');
      expect(Object.keys(config)).not.toContain('signingKeysJson');
    });

    it('never leaks the inline key set when the config is invalid', () => {
      const act = () => loadConfig({ ...validEnv, AUTH_SIGNING_KEYS: 'PRIVATE-KEY-MARKER', PORT: 'abc' });
      expect(act).toThrow('PORT');
      expect(act).not.toThrow('PRIVATE-KEY-MARKER');
    });
  });
});

describe('loadConfig: TRUST_PROXY (ADR 37)', () => {
  const trustProxy = (value: string) => loadConfig({ ...validEnv, TRUST_PROXY: value }).trustProxy;

  it('defaults to false, so X-Forwarded-For is ignored', () => {
    expect(loadConfig(validEnv).trustProxy).toBe(false);
    expect(trustProxy('false')).toBe(false);
  });

  it.each([['1', 1], ['2', 2], ['10', 10]])('accepts the hop count %s as a number', (value, expected) => {
    expect(trustProxy(value)).toBe(expected);
  });

  it.each(['loopback', 'loopback, uniquelocal', '10.0.0.0/8', '10.1.2.3/32', '10.1.2.3', '2000::/16', '2001:db8::/32', '::1'])(
    'passes the list %p through to Express',
    (value) => {
      expect(trustProxy(value)).toBe(value);
    },
  );

  // A hop count above 10 or a CIDR wider than /8 (IPv4) or /16 (IPv6) trusts far more than any real proxy chain.
  it.each([
    'true', 'TRUE', '0', '-1', '1.5', '', 'bogus', '10.0.0.0/33', 'loopback,,', '0.0.0.0/0', '::/0',
    '11', '100', '0.0.0.0/1', '10.0.0.0/7', '2000::/15', '::/1', 'loopback, 10.0.0.0/7',
  ])(
    'rejects %p at boot',
    (value) => {
      expect(() => trustProxy(value)).toThrow(ConfigError);
      expect(() => trustProxy(value)).toThrow('TRUST_PROXY');
    },
  );
});

describe('loadConfig: ABUSE_<SCOPE>_*', () => {
  it('leaves ABUSE_* to abuse-protection, so the platform neither parses nor exposes them', () => {
    const config = loadConfig({ ...validEnv, ABUSE_EMAIL_IP_LIMIT: '0' });
    expect(Object.keys(config)).not.toContain('abusePolicies');
  });
});
