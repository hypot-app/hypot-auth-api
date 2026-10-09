#!/usr/bin/env node
// Login latency gate (ADR 12): P95 of POST /api/v1/auth/login must stay under 500 ms at pilot load.
// Plain Node, no dependency. Run it by hand against a running instance, see "Capacity and load test" in the README.
//
//   LOAD_PASSWORD='...' node scripts/login-load.mjs --client-id app_... --email ana@example.com \
//     [--url http://localhost:3000] [--origin https://app.example] [--requests 200] [--concurrency 4] \
//     [--warmup 8] [--threshold-ms 500]
//
// Exit codes: 0 gate passed, 1 gate failed (slow, or any answer other than 200), 2 bad usage.
//
// Why a non-200 fails the gate: a limited or blocked login is answered before bcrypt runs, so it is fast. Counting
// those would let a rate-limited run "pass". Raise the ABUSE_LOGIN_* limits for the test run (or use a dedicated
// instance), because one account from one address is blocked after 5 attempts by design.

import http from 'node:http';
import https from 'node:https';
import { parseArgs } from 'node:util';

const USAGE = `usage: LOAD_PASSWORD=... node scripts/login-load.mjs --client-id <app_...> --email <address>
       [--url <base url>] [--origin <origin>] [--requests <n>] [--concurrency <n>] [--warmup <n>] [--threshold-ms <ms>]`;
const REQUEST_TIMEOUT_MS = 30_000;

function fail(message) {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

const positive = (name, raw, fallback) => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(`--${name} must be a positive integer`);
  return value;
};

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// No keep-alive: every login opens its own connection, like separate browsers, and the process can end cleanly.
const agents = { 'http:': new http.Agent({ keepAlive: false }), 'https:': new https.Agent({ keepAlive: false }) };

function login(target, body, origin) {
  const url = new URL(target);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
  if (origin !== undefined) headers.Origin = origin;
  const start = process.hrtime.bigint();
  return new Promise((resolve) => {
    const done = (status) => resolve({ status, ms: Number(process.hrtime.bigint() - start) / 1e6 });
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'POST', headers, agent: agents[url.protocol], timeout: REQUEST_TIMEOUT_MS }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode ?? 0));
    });
    // 0 stands for a network error or a timeout.
    req.on('timeout', () => req.destroy());
    req.on('error', () => done(0));
    req.end(body);
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      'client-id': { type: 'string' },
      email: { type: 'string' },
      origin: { type: 'string' },
      requests: { type: 'string' },
      concurrency: { type: 'string' },
      warmup: { type: 'string' },
      'threshold-ms': { type: 'string' },
    },
    strict: true,
  });
  const password = process.env.LOAD_PASSWORD;
  if (values['client-id'] === undefined || values.email === undefined) fail('--client-id and --email are required');
  if (password === undefined || password === '') fail('set LOAD_PASSWORD (the password is never taken from an argument)');

  const baseUrl = (values.url ?? 'http://localhost:3000').replace(/\/+$/, '');
  const target = `${baseUrl}/api/v1/auth/login`;
  const total = positive('requests', values.requests, 200);
  const concurrency = positive('concurrency', values.concurrency, 4);
  const warmup = positive('warmup', values.warmup, 8);
  const thresholdMs = positive('threshold-ms', values['threshold-ms'], 500);
  const body = JSON.stringify({ client_id: values['client-id'], email: values.email, password });

  // Warm-up: connection setup, JIT and the libuv threadpool, not counted. It still consumes login attempts.
  for (let i = 0; i < warmup; i++) await login(target, body, values.origin);

  const results = [];
  let issued = 0;
  const startedAt = process.hrtime.bigint();
  const worker = async () => {
    while (issued < total) {
      issued += 1;
      results.push(await login(target, body, values.origin));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const { status } of results) byStatus[status] = (byStatus[status] ?? 0) + 1;
  const notOk = results.length - (byStatus[200] ?? 0);
  const p95 = percentile(latencies, 95);
  const round = (n) => Math.round(n * 10) / 10;

  const lines = [
    `target        ${target}`,
    `requests      ${results.length} at concurrency ${concurrency} (after ${warmup} warm-up)`,
    `throughput    ${round(results.length / elapsedSeconds)} logins/s over ${round(elapsedSeconds)} s`,
    `statuses      ${Object.entries(byStatus).map(([s, n]) => `${s === '0' ? 'network error' : s}: ${n}`).join(', ')}`,
    `latency ms    min ${round(latencies[0])}  median ${round(percentile(latencies, 50))}  p95 ${round(p95)}  p99 ${round(percentile(latencies, 99))}  max ${round(latencies.at(-1))}`,
  ];
  const problems = [];
  if (notOk > 0) problems.push(`${notOk} answers were not 200: limits or credentials are wrong, so the latency says nothing about bcrypt`);
  if (!(p95 < thresholdMs)) problems.push(`p95 ${round(p95)} ms is not under ${thresholdMs} ms`);
  lines.push(problems.length === 0 ? `GATE PASSED   p95 ${round(p95)} ms < ${thresholdMs} ms` : `GATE FAILED   ${problems.join('; ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  // Not process.exit(): let the sockets close first (an abrupt exit can crash libuv on Windows).
  process.exitCode = problems.length === 0 ? 0 : 1;
}

await main();
