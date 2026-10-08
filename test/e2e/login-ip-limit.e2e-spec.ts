import { randomUUID } from 'node:crypto';
import { Body, Controller, Post, Req, type INestApplication } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import request from 'supertest';
import { RegisterAppUseCase } from '../../src/app-registry/application/register-app.use-case';
import { ResolveClientUseCase } from '../../src/app-registry/application/resolve-client.use-case';
import { AbuseGuard } from '../../src/abuse-protection/application/abuse-guard';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import { ClientRef } from '../../src/abuse-protection/domain/client-ref';
import { resolvePolicies } from '../../src/abuse-protection/domain/policy';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const LOGIN_IP_LIMIT = 3;

// Stands in for the first lines of the login use case: resolve the client, then limit by IP with a ClientRef.
// A known app gets its own ref; every other client_id shares the sentinel (ADR 34, task 14.0).
@Controller('auth')
class LoginIpProbeController {
  constructor(private readonly moduleRef: ModuleRef) {}

  @Post('login-probe')
  async probe(
    @Body() body: { client_id: string },
    @Req() req: { ip?: string; socket: { remoteAddress?: string } },
  ): Promise<{ allowed: boolean }> {
    const resolved = await this.moduleRef.get(ResolveClientUseCase, { strict: false }).execute({ clientId: body.client_id });
    const client = resolved.ok ? ClientRef.resolved(resolved.value) : ClientRef.unknown();
    const guard = this.moduleRef.get(AbuseGuard, { strict: false });
    return { allowed: await guard.checkLoginIp(client, ClientIp.from(req.ip, req.socket.remoteAddress)) };
  }
}

describe('login_ip limit across random client_id values (e2e, task 14.0)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let knownClientId: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp({
      databaseUrl: db.url,
      controllers: [LoginIpProbeController],
      abusePolicies: resolvePolicies({ login_ip: { limit: LOGIN_IP_LIMIT } }),
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
    knownClientId = registered.value.app.clientId;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.teardown();
  }, 60_000);

  const probe = async (clientId: string): Promise<boolean> =>
    (await request(app.getHttpServer()).post('/api/v1/auth/login-probe').send({ client_id: clientId }).expect(201)).body.allowed;
  const loginIpRows = async (): Promise<number> =>
    Number((await db.dataSource.query(`SELECT count(*) AS n FROM abuse_counters WHERE scope = 'login_ip'`))[0].n);

  it('shares ONE limit and ONE counter row between random client_id values from one IP', async () => {
    const decisions: boolean[] = [];
    for (let i = 0; i < LOGIN_IP_LIMIT + 4; i += 1) decisions.push(await probe(`app_${randomUUID()}`));

    expect(decisions).toEqual([true, true, true, false, false, false, false]);
    expect(await loginIpRows()).toBe(1);
  });

  it('keeps a known app on its own counter, so the sentinel being full does not lock it out', async () => {
    expect(await probe(knownClientId)).toBe(true);
    expect(await loginIpRows()).toBe(2);
  });
});
