import { Controller, Post, Req, type INestApplication } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import request from 'supertest';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { CorsGrant } from '../../src/app-registry/http/cors-grant';
import { AbuseCounterSweeper } from '../../src/abuse-protection/application/abuse-counter-sweeper';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { RateLimitedException } from '../../src/abuse-protection/http/abuse-exception.filter';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

// Stands in for an endpoint of a later unit: limit by IP first, grant CORS on the 429 (it carries no app data).
@Controller('accounts')
class ConfirmProbeController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Post('confirm')
  async confirm(
    @Req() req: { ip?: string; socket: { remoteAddress?: string } },
    @CorsGrant() grantCors: () => void,
  ): Promise<{ ok: true }> {
    const guard = this.moduleRef.get(AbuseGuard, { strict: false });
    const decision = await guard.checkIp('confirm_ip', ClientIp.from(req.ip, req.socket.remoteAddress));
    if (decision.kind === 'ip_limited') {
      grantCors();
      throw new RateLimitedException(decision.retryAfterSeconds);
    }
    return { ok: true };
  }
}

describe('abuse protection wiring (e2e)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  const startSpy = jest.spyOn(AbuseCounterSweeper.prototype, 'start');

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      controllers: [ConfirmProbeController],
      config: { abusePolicies: resolvePolicies({ confirm_ip: { limit: 1 } }) },
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

  const confirm = () => request(app.getHttpServer()).post('/api/v1/accounts/confirm').set('Origin', 'https://a.example');

  it('limits by IP with a 429, an integer Retry-After and a body a browser on the app origin can read', async () => {
    await confirm().expect(201);

    const limited = await confirm().expect(429);

    expect(limited.headers['retry-after']).toMatch(/^[1-9]\d*$/);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect(limited.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again later.' });
    expect(limited.headers['access-control-allow-origin']).toBe('https://a.example');
  });

  it('fails closed with a 503 when the counter table is unavailable', async () => {
    await db.dataSource.query('ALTER TABLE abuse_counters RENAME TO abuse_counters_off');
    try {
      const response = await confirm().expect(503);
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
