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
      expect(run.errors.map((e) => e.message)).toEqual(['--type must be "public" or "confidential", got "weird"']);
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
      const run = await cli(['app', 'create', '--name', 'Shop']);
      expect(clientIdFrom(run.out)).toMatch(/^app_[0-9a-f]{32}$/);
    });
  });

  describe('app create origin and redirect uri validation', () => {
    it('stores origins normalized (lower-case, de-duplicated)', async () => {
      const run = await cli(['app', 'create', '--name', 'Shop', '--origin', 'HTTPS://A.example', '--origin', 'https://a.example']);
      expect(run.errors).toEqual([]);
      expect((await rows())[0].allowed_origins).toEqual(['https://a.example']);
    });

    it.each(['https://a.example/', 'https://a.example/app', 'null', '*', 'http://a.example'])(
      'rejects the origin %s with a clear error and persists nothing',
      async (origin) => {
        const run = await cli(['app', 'create', '--name', 'Shop', '--type', 'confidential', '--origin', origin]);

        expect(run.errors).toHaveLength(1);
        expect(run.errors[0].message).toContain(`Invalid allowed origin "${origin}"`);
        expect(run.out.join('\n')).not.toMatch(/client_(id|secret)/);
        expect(await rows()).toHaveLength(0);
      },
    );

    it('rejects an email-from with a display name and persists nothing', async () => {
      const run = await cli(['app', 'create', '--name', 'Shop', '--email-from', 'Shop <hello@a.example>']);

      expect(run.errors).toHaveLength(1);
      expect(run.errors[0].message).toContain('Invalid email_from');
      expect(await rows()).toHaveLength(0);
    });

    it.each(['/cb', 'https://a.example/cb#x', 'http://a.example/cb', 'myapp://cb'])(
      'rejects the redirect uri %s with a clear error and persists nothing',
      async (uri) => {
        const run = await cli(['app', 'create', '--name', 'Shop', '--redirect-uri', uri]);

        expect(run.errors).toHaveLength(1);
        expect(run.errors[0].message).toContain(`Invalid redirect URI "${uri}"`);
        expect(await rows()).toHaveLength(0);
      },
    );

    it('rejects an http localhost origin in production', async () => {
      const run = await cli(['app', 'create', '--name', 'Dev', '--origin', 'http://localhost:5173'], {
        isProduction: true,
      });
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

    it('rejects an invalid origin or redirect uri and persists no change', async () => {
      const clientId = await createApp(['--origin', 'https://a.example']);

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
      expect((await rows())[0].allowed_origins).toEqual([]);
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
