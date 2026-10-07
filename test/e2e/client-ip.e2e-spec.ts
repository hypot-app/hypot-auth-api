import { Controller, Get, Req, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClientIp } from '../../src/abuse-protection/domain/client-ip';
import type { AppConfig } from '../../src/platform/config/app-config';
import { createTestApp } from '../support/create-test-app';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

// Test-only route: reports the key the limiter would use for the caller.
@Controller('ip-echo')
class IpEchoController {
  @Get()
  echo(@Req() req: { ip?: string; socket: { remoteAddress?: string } }): { ip: string } {
    return { ip: ClientIp.from(req.ip, req.socket.remoteAddress).key };
  }
}

describe('client IP and trust proxy (e2e, ADR 37)', () => {
  let db: TestDatabase;
  const apps: INestApplication[] = [];

  const ipSeenBehind = async (trustProxy: AppConfig['trustProxy'], forwardedFor: string): Promise<string> => {
    const app = await createTestApp({
      databaseUrl: db.url,
      controllers: [IpEchoController],
      config: { trustProxy },
    });
    apps.push(app);
    const response = await request(app.getHttpServer()).get('/api/v1/ip-echo').set('X-Forwarded-For', forwardedFor);
    return (response.body as { ip: string }).ip;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 180_000);

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await db?.teardown();
  }, 60_000);

  it('ignores a spoofed X-Forwarded-For when no proxy is trusted', async () => {
    expect(await ipSeenBehind(false, '1.2.3.4')).toBe('127.0.0.1');
  });

  it('takes the first untrusted address from the right behind a trusted proxy', async () => {
    expect(await ipSeenBehind('loopback', '1.2.3.4, 203.0.113.9')).toBe('203.0.113.9');
  });

  it('skips every trusted hop and still ignores the spoofed leftmost value', async () => {
    expect(await ipSeenBehind('loopback, uniquelocal', '1.2.3.4, 203.0.113.9, 10.0.0.5')).toBe('203.0.113.9');
  });

  it('falls back to the peer address when the forwarded value is malformed', async () => {
    expect(await ipSeenBehind('loopback', 'not-an-ip')).toBe('127.0.0.1');
  });
});
