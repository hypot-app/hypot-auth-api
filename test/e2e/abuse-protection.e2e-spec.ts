import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { AbuseCounterSweeper } from '../../src/abuse-protection/application/abuse-counter-sweeper';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

describe('abuse protection wiring (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  const startSpy = jest.spyOn(AbuseCounterSweeper.prototype, 'start');

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      abusePolicies: resolvePolicies({ confirm_ip: { limit: 1 } }),
    });
    const registered = await app.get(RegisterAppUseCase).execute({
      name: 'A',
      clientType: 'public',
      redirectUris: [],
      allowedOrigins: ['https://a.example'],
      emailConfirmationUrl: 'https://a.example/confirm',
      passwordResetUrl: 'https://a.example/reset',
      isProduction: false,
    });
    if (!registered.ok) throw registered.error;
  }, 180_000);

  afterAll(async () => {
    startSpy.mockRestore();
    await app?.close();
    await db?.teardown();
  }, 60_000);

  // The real confirm endpoint: the limit runs before the token is looked up, so any token body will do.
  const confirm = (origin?: string) => {
    const req = request(app.getHttpServer()).post('/api/v1/accounts/confirm').send({ token: 'A'.repeat(43) });
    return origin === undefined ? req : req.set('Origin', origin);
  };

  it('limits by IP with a 429, an integer Retry-After and a body a browser on the app origin can read', async () => {
    await confirm('https://a.example').expect(400);

    const limited = await confirm('https://a.example').expect(429);

    expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect(limited.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    expect(limited.headers['access-control-allow-origin']).toBe('https://a.example');
  });

  it.each([
    ['no Origin header', undefined],
    ['an origin that belongs to no active app', 'https://evil.example'],
  ])('adds no allow header to a 429 for %s', async (_name, origin) => {
    const limited = await confirm(origin).expect(429);
    expect(limited.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('fails closed with a 503 when the counter table is unavailable, readable from an active app origin', async () => {
    await db.dataSource.query('ALTER TABLE abuse_counters RENAME TO abuse_counters_off');
    try {
      const response = await confirm('https://a.example').expect(503);
      expect(response.headers['access-control-allow-origin']).toBe('https://a.example');
      expect((await confirm().expect(503)).headers['access-control-allow-origin']).toBeUndefined();
      expect((await confirm('https://evil.example').expect(503)).headers['access-control-allow-origin']).toBeUndefined();
      expect(response.body).toEqual({
        error: 'temporarily_unavailable',
        message: 'The service is temporarily unavailable. Try again later.',
      });
      expect(response.headers['retry-after']).toBeUndefined();
    } finally {
      await db.dataSource.query('ALTER TABLE abuse_counters_off RENAME TO abuse_counters');
    }
  });

  it('exports the guard and sweeper, but never starts the sweeper on its own', () => {
    expect(app.get(AbuseGuard, { strict: false })).toBeInstanceOf(AbuseGuard);
    expect(app.get(AbuseCounterSweeper, { strict: false })).toBeInstanceOf(AbuseCounterSweeper);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
