import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'login-load.mjs');
const CLIENT_ID = 'app_0123456789abcdef0123456789abcdef';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the script to completion against a stub on loopback. No hypot server is involved. */
function runScript(args: string[], env: Record<string, string> = { LOAD_PASSWORD: 'correct horse' }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, LOAD_PASSWORD: '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('scripts/login-load.mjs (19.12)', () => {
  let server: Server;
  let url: string;
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  const seen: { method?: string; url?: string; body: string; origin?: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, body, origin: req.headers.origin });
        handler(req, res, body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    seen.length = 0;
    handler = (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });

  const common = ['--url', '', '--client-id', CLIENT_ID, '--email', 'ana@example.com', '--warmup', '2', '--requests', '20', '--concurrency', '4'];
  const withUrl = (extra: string[] = []) => [...common.map((value, i) => (common[i - 1] === '--url' ? url : value)), ...extra];

  it('passes the gate when every login answers 200 under the threshold, and posts the documented request', async () => {
    const run = await runScript(withUrl(['--origin', 'https://app.example']));

    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/GATE PASSED\s+p95 [\d.]+ ms < 500 ms/);
    expect(run.stdout).toMatch(/requests\s+20 at concurrency 4 \(after 2 warm-up\)/);
    expect(run.stdout).toMatch(/statuses\s+200: 20/);
    expect(seen).toHaveLength(22);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/auth/login', origin: 'https://app.example' });
    expect(JSON.parse(seen[0]!.body)).toEqual({ client_id: CLIENT_ID, email: 'ana@example.com', password: 'correct horse' });
  });

  it('fails the gate when the p95 is over the threshold', async () => {
    handler = (_req, res) => setTimeout(() => res.writeHead(200).end('{}'), 120);

    const run = await runScript(withUrl(['--threshold-ms', '60']));

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/GATE FAILED\s+p95 1\d\d(\.\d)? ms is not under 60 ms/);
  });

  it('fails the gate when any answer is not 200, even if it is fast (a limited login skips bcrypt)', async () => {
    let calls = 0;
    handler = (_req, res) => res.writeHead(++calls % 10 === 0 ? 401 : 200).end('{}');

    const run = await runScript(withUrl());

    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/401: 2/);
    expect(run.stdout).toMatch(/GATE FAILED\s+2 answers were not 200/);
  });

  it.each([
    ['no client id', ['--email', 'a@b.c'], { LOAD_PASSWORD: 'x' }, '--client-id and --email are required'],
    ['no password in the environment', ['--client-id', CLIENT_ID, '--email', 'a@b.c'], {}, 'set LOAD_PASSWORD'],
    ['a non-numeric --requests', ['--client-id', CLIENT_ID, '--email', 'a@b.c', '--requests', 'many'], { LOAD_PASSWORD: 'x' }, '--requests must be a positive integer'],
  ])('exits 2 with usage for %s', async (_label, args, env, message) => {
    const run = await runScript(args, env);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain(message);
    expect(run.stderr).toContain('usage:');
    expect(seen).toHaveLength(0);
  });
});
