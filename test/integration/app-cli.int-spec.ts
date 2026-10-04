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
  post_reset_redirect_uri: string | null;
  status: string;
}

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
        '--origin',
        'https://a.example',
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
        post_reset_redirect_uri: null,
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
      const run = await cli(['app', 'create', '--name', 'X', '--type', 'weird']);
      expect(run.errors.length + run.err.length).toBeGreaterThan(0);
      expect(await rows()).toHaveLength(0);
    });

    it('requires --name', async () => {
      const run = await cli(['app', 'create']);
      expect(run.errors.length + run.err.length).toBeGreaterThan(0);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('app create --post-reset-redirect-uri', () => {
    it('stores a valid https value as given', async () => {
      const run = await cli(['app', 'create', '--name', 'Shop', '--post-reset-redirect-uri', 'https://a.example/login']);
      expect(run.errors).toEqual([]);
      expect((await rows())[0].post_reset_redirect_uri).toBe('https://a.example/login');
    });

    it('stores null when the option is omitted', async () => {
      await cli(['app', 'create', '--name', 'Shop']);
      expect((await rows())[0].post_reset_redirect_uri).toBeNull();
    });

    it.each([
      '/login',
      'javascript:alert(1)',
      'ftp://a.example/x',
      'https://u:p@a.example/x',
      'https://a.example/x#f',
      'http://a.example/login',
    ])('rejects %s with a validation error and persists nothing', async (uri) => {
      const run = await cli([
        'app',
        'create',
        '--name',
        'Shop',
        '--type',
        'confidential',
        '--post-reset-redirect-uri',
        uri,
      ]);

      expect(run.errors).toHaveLength(1);
      expect(run.errors[0].message).toMatch(/post-reset redirect URI/i);
      expect(run.out.join('\n')).not.toMatch(/client_secret/);
      expect(await rows()).toHaveLength(0);
    });

    it('accepts http://localhost outside production', async () => {
      const run = await cli([
        'app',
        'create',
        '--name',
        'Dev',
        '--post-reset-redirect-uri',
        'http://localhost:3000/login',
      ]);
      expect(run.errors).toEqual([]);
      expect((await rows())[0].post_reset_redirect_uri).toBe('http://localhost:3000/login');
    });

    it('rejects http://localhost when NODE_ENV=production', async () => {
      const run = await cli(
        ['app', 'create', '--name', 'Dev', '--post-reset-redirect-uri', 'http://localhost:3000/login'],
        { isProduction: true },
      );
      expect(run.errors).toHaveLength(1);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe('app update', () => {
    const createApp = async (extra: string[] = []): Promise<string> => {
      const run = await cli(['app', 'create', '--name', 'Shop', '--redirect-uri', 'https://a.example/cb', ...extra]);
      return clientIdFrom(run.out);
    };

    it('updates name, redirect URIs and origins; repeated options replace the list', async () => {
      const clientId = await createApp(['--origin', 'https://a.example']);
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
      ]);

      expect(run.errors).toEqual([]);
      expect((await rows())[0]).toMatchObject({
        name: 'Renamed',
        redirect_uris: ['https://b.example/cb'],
        allowed_origins: ['https://b.example'],
      });
    });

    it('sets a new post-reset redirect URI', async () => {
      const clientId = await createApp(['--post-reset-redirect-uri', 'https://a.example/login']);
      await cli(['app', 'update', clientId, '--post-reset-redirect-uri', 'https://a.example/welcome']);
      expect((await rows())[0].post_reset_redirect_uri).toBe('https://a.example/welcome');
    });

    it('leaves the post-reset redirect URI alone when the option is omitted', async () => {
      const clientId = await createApp(['--post-reset-redirect-uri', 'https://a.example/login']);
      await cli(['app', 'update', clientId, '--name', 'Renamed']);
      expect((await rows())[0].post_reset_redirect_uri).toBe('https://a.example/login');
    });

    it('clears it with --clear-post-reset-redirect-uri', async () => {
      const clientId = await createApp(['--post-reset-redirect-uri', 'https://a.example/login']);
      const run = await cli(['app', 'update', clientId, '--clear-post-reset-redirect-uri']);
      expect(run.errors).toEqual([]);
      expect((await rows())[0].post_reset_redirect_uri).toBeNull();
    });

    it('rejects an invalid value and persists no change at all', async () => {
      const clientId = await createApp(['--post-reset-redirect-uri', 'https://a.example/login']);
      const run = await cli([
        'app',
        'update',
        clientId,
        '--name',
        'Changed',
        '--post-reset-redirect-uri',
        'http://a.example/login',
      ]);

      expect(run.errors).toHaveLength(1);
      expect((await rows())[0]).toMatchObject({ name: 'Shop', post_reset_redirect_uri: 'https://a.example/login' });
    });

    it('rejects http://localhost in production', async () => {
      const clientId = await createApp();
      const run = await cli(['app', 'update', clientId, '--post-reset-redirect-uri', 'http://localhost:3000/login'], {
        isProduction: true,
      });
      expect(run.errors).toHaveLength(1);
      expect((await rows())[0].post_reset_redirect_uri).toBeNull();
    });

    it('rejects combining the set and clear options', async () => {
      const clientId = await createApp(['--post-reset-redirect-uri', 'https://a.example/login']);
      const run = await cli([
        'app',
        'update',
        clientId,
        '--post-reset-redirect-uri',
        'https://a.example/new',
        '--clear-post-reset-redirect-uri',
      ]);
      expect(run.errors).toHaveLength(1);
      expect((await rows())[0].post_reset_redirect_uri).toBe('https://a.example/login');
    });

    it('fails for an unknown client_id', async () => {
      const run = await cli(['app', 'update', 'nope', '--name', 'x']);
      expect(run.errors).toHaveLength(1);
      expect(run.errors[0].message).toMatch(/nope/);
    });
  });

  describe('app deactivate', () => {
    it('marks the app inactive', async () => {
      const created = await cli(['app', 'create', '--name', 'Shop']);
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
