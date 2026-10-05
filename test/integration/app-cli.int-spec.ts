import { hashToken } from '../../src/shared-kernel/token-generator';
import { runCli } from '../support/cli-harness';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

interface AppDbRow {
  client_id: string;
  name: string;
  client_type: string;
  client_secret_hash: Buffer | null;
  redirect_uris: string[];
  allowed_origins: string[];
  email_from: string | null;
  email_confirmation_url: string | null;
  password_reset_url: string | null;
  status: string;
}

const ORIGIN = ['--origin', 'https://a.example'];
const URLS = [
  '--email-confirmation-url',
  'https://a.example/confirm',
  '--password-reset-url',
  'https://a.example/reset',
];
/** Everything `app create` requires, so a test only spells out what it varies. */
const REQUIRED = ['--name', 'Shop', ...ORIGIN, ...URLS];

describe('app CLI (integration)', () => {
  let db: TestDatabase;

  const cli = (args: string[], config: { isProduction?: boolean } = {}) =>
    runCli(args, {
      databaseUrl: db.url,
      config: { isProduction: config.isProduction ?? false, nodeEnv: config.isProduction ? 'production' : 'test' },
    });
  const rows = (): Promise<AppDbRow[]> => db.dataSource.query('SELECT * FROM apps ORDER BY created_at');
  const clientIdFrom = (out: string[]): string => {
    const line = out.find((l) => l.startsWith('client_id: '));
    if (!line) throw new Error(`no client_id in output: ${out.join('|')}`);
    return line.slice('client_id: '.length);
  };

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  describe('app create', () => {
    it('creates a public app, prints its client_id and no secret', async () => {
      const run = await cli([
        'app',
        'create',
        '--name',
        'Shop',
        '--redirect-uri',
        'https://a.example/cb',
        '--redirect-uri',
        'https://a.example/cb2',
        ...ORIGIN,
        ...URLS,
      ]);

      expect(run.errors).toEqual([]);
      const [row] = await rows();
      expect(run.out).toContain(`client_id: ${row.client_id}`);
      expect(run.out.join('\n')).not.toMatch(/client_secret/);
      expect(row).toMatchObject({
        name: 'Shop',
        client_type: 'public',
        client_secret_hash: null,
        redirect_uris: ['https://a.example/cb', 'https://a.example/cb2'],
        allowed_origins: ['https://a.example'],
        email_confirmation_url: 'https://a.example/confirm',
        password_reset_url: 'https://a.example/reset',
        status: 'active',
      });
    });

    it('creates a confidential app: secret printed exactly once, only its hash stored', async () => {
      const run = await cli([
        'app',
        'create',
        '--name',
        'Backend',
        '--type',
        'confidential',
        '--redirect-uri',
        'https://b.example/cb',
        ...ORIGIN,
        ...URLS,
      ]);

      expect(run.errors).toEqual([]);
      const secretLines = run.out.filter((l) => l.startsWith('client_secret: '));
      expect(secretLines).toHaveLength(1);
      const secret = secretLines[0].slice('client_secret: '.length);

      const [row] = await rows();
      expect(row.client_secret_hash?.equals(hashToken(secret))).toBe(true);
      expect(JSON.stringify(await rows())).not.toContain(secret);
      expect(run.err.join('\n')).not.toContain(secret);
    });

    it('rejects an unknown --type without persisting', async () => {
      const run = await cli(['app', 'create', '--name', 'X', '--type', 'weird', ...ORIGIN, ...URLS]);
      expect(run.errors.map((e) => e.message)).toEqual(['--type must be "public" or "confidential", got "weird"']);
      expect(await rows()).toHaveLength(0);
    });

    it.each([
      ['--email-confirmation-url', ['--password-reset-url', 'https://a.example/reset']],
      ['--password-reset-url', ['--email-confirmation-url', 'https://a.example/confirm']],
    ])('requires %s', async (flag, other) => {
      const run = await cli(['app', 'create', '--name', 'Shop', ...ORIGIN, ...other]);
      expect(run.errors.map((e) => e.message)).toEqual([`${flag} is required`]);
      expect(await rows()).toHaveLength(0);
    });

    it('rejects an invalid email link URL and persists nothing', async () => {
      const run = await cli(['app', 'create', ...REQUIRED, '--password-reset-url', 'https://a.example/x#token=']);
      expect(run.errors.map((e) => e.message)).toEqual([expect.stringContaining('Invalid password_reset_url')]);
      expect(await rows()).toHaveLength(0);
    });

    it('rejects an email link URL on an origin that is not allowed and persists nothing', async () => {
      const run = await cli(['app', 'create', ...REQUIRED, '--email-confirmation-url', 'https://evil.example/x']);
      expect(run.errors.map((e) => e.message)).toEqual([
        'email_confirmation_url origin "https://evil.example" must be one of the allowed origins (add it with --origin)',
      ]);
      expect(await rows()).toHaveLength(0);
    });

    it('requires at least one --origin, before checking the URL origins', async () => {
      const run = await cli(['app', 'create', '--name', 'Shop', ...URLS]);
      expect(run.errors.map((e) => e.message)).toEqual(['at least one --origin is required']);
      expect(await rows()).toHaveLength(0);
    });

    it('rejects an http://localhost email link URL in production', async () => {
      const run = await cli(['app', 'create', ...REQUIRED, '--email-confirmation-url', 'http://localhost:5173/x'], {
        isProduction: true,
      });
      expect(run.errors.map((e) => e.message)).toEqual([expect.stringContaining('Invalid email_confirmation_url')]);
      expect(await rows()).toHaveLength(0);
    });

    it('rejects the removed --post-reset-redirect-uri option as unknown, exiting with code 1', async () => {
      // commander itself prints the message and calls process.exit(1) for an unknown option.
      const exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
      const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const run = await cli(['app', 'create', ...REQUIRED, '--post-reset-redirect-uri', 'https://a.example/login']);
        expect(run.errors.map((e) => e.message)).toEqual(['process.exit(1)']);
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown option '--post-reset-redirect-uri'"));
      } finally {
        exit.mockRestore();
        stderr.mockRestore();
      }
      expect(await rows()).toHaveLength(0);
    });

    it('requires --name', async () => {
      const run = await cli(['app', 'create']);
      expect(run.errors.map((e) => e.message)).toEqual(['--name is required']);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('app create client_id', () => {
    it('prints a client_id shaped app_<32 hex>, safe to pass as a CLI argument', async () => {
      const run = await cli(['app', 'create', ...REQUIRED]);
      expect(clientIdFrom(run.out)).toMatch(/^app_[0-9a-f]{32}$/);
    });
  });

  describe('app create origin and redirect uri validation', () => {
    it('stores origins normalized (lower-case, de-duplicated)', async () => {
      const run = await cli(['app', 'create', '--name', 'Shop', '--origin', 'HTTPS://A.example', '--origin', 'https://a.example', ...URLS]);
      expect(run.errors).toEqual([]);
      expect((await rows())[0].allowed_origins).toEqual(['https://a.example']);
    });

    it.each(['https://a.example/', 'https://a.example/app', 'null', '*', 'http://a.example'])(
      'rejects the origin %s with a clear error and persists nothing',
      async (origin) => {
        const run = await cli(['app', 'create', '--name', 'Shop', '--type', 'confidential', '--origin', origin, ...URLS]);

        expect(run.errors).toHaveLength(1);
        expect(run.errors[0].message).toContain(`Invalid allowed origin "${origin}"`);
        expect(run.out.join('\n')).not.toMatch(/client_(id|secret)/);
        expect(await rows()).toHaveLength(0);
      },
    );

    it('rejects an email-from with a display name and persists nothing', async () => {
      const run = await cli(['app', 'create', ...REQUIRED, '--email-from', 'Shop <hello@a.example>']);

      expect(run.errors).toHaveLength(1);
      expect(run.errors[0].message).toContain('Invalid email_from');
      expect(await rows()).toHaveLength(0);
    });

    it.each(['/cb', 'https://a.example/cb#x', 'http://a.example/cb', 'myapp://cb'])(
      'rejects the redirect uri %s with a clear error and persists nothing',
      async (uri) => {
        const run = await cli(['app', 'create', ...REQUIRED, '--redirect-uri', uri]);

        expect(run.errors).toHaveLength(1);
        expect(run.errors[0].message).toContain(`Invalid redirect URI "${uri}"`);
        expect(await rows()).toHaveLength(0);
      },
    );

    it('rejects an http localhost origin in production', async () => {
      const run = await cli(['app', 'create', '--name', 'Dev', '--origin', 'http://localhost:5173', ...URLS], {
        isProduction: true,
      });
      expect(run.errors).toHaveLength(1);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('app update', () => {
    const createApp = async (extra: string[] = []): Promise<string> => {
      const run = await cli(['app', 'create', ...REQUIRED, '--redirect-uri', 'https://a.example/cb', ...extra]);
      return clientIdFrom(run.out);
    };

    it('updates name, redirect URIs, origins and email link URLs; repeated options replace the list', async () => {
      const clientId = await createApp();
      const run = await cli([
        'app',
        'update',
        clientId,
        '--name',
        'Renamed',
        '--redirect-uri',
        'https://b.example/cb',
        '--origin',
        'https://b.example',
        '--email-confirmation-url',
        'https://b.example/confirm',
        '--password-reset-url',
        'https://b.example/reset',
      ]);

      expect(run.errors).toEqual([]);
      expect((await rows())[0]).toMatchObject({
        name: 'Renamed',
        redirect_uris: ['https://b.example/cb'],
        allowed_origins: ['https://b.example'],
        email_confirmation_url: 'https://b.example/confirm',
        password_reset_url: 'https://b.example/reset',
      });
    });

    it.each([
      ['--email-confirmation-url', 'email_confirmation_url'],
      ['--password-reset-url', 'password_reset_url'],
    ])('rejects clearing %s with an empty value and keeps the stored URL', async (flag, field) => {
      const clientId = await createApp();
      const run = await cli(['app', 'update', clientId, '--name', 'Changed', flag, '']);

      expect(run.errors.map((e) => e.message)).toEqual([expect.stringContaining(`Invalid ${field}`)]);
      expect((await rows())[0]).toMatchObject({
        name: 'Shop',
        email_confirmation_url: 'https://a.example/confirm',
        password_reset_url: 'https://a.example/reset',
      });
    });

    it('rejects removing the origin a stored email link URL uses', async () => {
      const clientId = await createApp();
      const run = await cli(['app', 'update', clientId, '--origin', 'https://b.example']);

      expect(run.errors.map((e) => e.message)).toEqual([expect.stringContaining('must be one of the allowed origins')]);
      expect((await rows())[0].allowed_origins).toEqual(['https://a.example']);
    });

    it('rejects an invalid origin or redirect uri and persists no change', async () => {
      const clientId = await createApp();

      const badOrigin = await cli(['app', 'update', clientId, '--name', 'Changed', '--origin', 'https://b.example/']);
      expect(badOrigin.errors.map((e) => e.message)).toEqual([expect.stringContaining('Invalid allowed origin')]);

      const badUri = await cli(['app', 'update', clientId, '--name', 'Changed', '--redirect-uri', '/cb']);
      expect(badUri.errors.map((e) => e.message)).toEqual([expect.stringContaining('Invalid redirect URI')]);

      expect((await rows())[0]).toMatchObject({
        name: 'Shop',
        allowed_origins: ['https://a.example'],
        redirect_uris: ['https://a.example/cb'],
      });
    });

    it('rejects http://localhost in production', async () => {
      const clientId = await createApp();
      const run = await cli(['app', 'update', clientId, '--origin', 'http://localhost:5173'], {
        isProduction: true,
      });
      expect(run.errors).toHaveLength(1);
      expect((await rows())[0].allowed_origins).toEqual(['https://a.example']);
    });

    it('fails for an unknown client_id', async () => {
      const run = await cli(['app', 'update', 'nope', '--name', 'x']);
      expect(run.errors).toHaveLength(1);
      expect(run.errors[0].message).toMatch(/nope/);
    });
  });

  describe('app deactivate', () => {
    it('marks the app inactive', async () => {
      const created = await cli(['app', 'create', ...REQUIRED]);
      const clientId = clientIdFrom(created.out);

      const run = await cli(['app', 'deactivate', clientId]);

      expect(run.errors).toEqual([]);
      expect((await rows())[0].status).toBe('inactive');
    });

    it('fails for an unknown client_id', async () => {
      const run = await cli(['app', 'deactivate', 'nope']);
      expect(run.errors).toHaveLength(1);
    });
  });
});
