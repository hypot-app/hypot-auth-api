import { InMemoryAppRepository, PassThroughUnitOfWork } from '../../../test/support/in-memory-app.repository';
import { FixedClock } from '../../shared-kernel/clock';
import { App } from '../domain/app';
import { DeactivateAppUseCase } from './deactivate-app.use-case';
import { UpdateAppUseCase } from './update-app.use-case';

const CREATED = new Date('2026-01-01T00:00:00.000Z');
const NOW = new Date('2026-03-03T10:00:00.000Z');

describe('UpdateAppUseCase / DeactivateAppUseCase', () => {
  let apps: InMemoryAppRepository;
  let update: UpdateAppUseCase;
  let deactivate: DeactivateAppUseCase;

  beforeEach(async () => {
    apps = new InMemoryAppRepository();
    const deps = { apps, clock: new FixedClock(NOW), uow: new PassThroughUnitOfWork() };
    update = new UpdateAppUseCase(deps);
    deactivate = new DeactivateAppUseCase(deps);
    await apps.save(
      App.restore({
        id: '11111111-1111-4111-8111-111111111111',
        clientId: 'abc',
        name: 'Shop',
        clientType: 'public',
        clientSecretHash: null,
        redirectUris: ['https://a.example/cb'],
        allowedOrigins: ['https://a.example'],
        emailFrom: null,
        emailConfirmationUrl: null,
        passwordResetUrl: null,
        status: 'active',
        createdAt: CREATED,
        updatedAt: CREATED,
      }),
    );
  });

  it('updates the given fields and persists them', async () => {
    const result = await update.execute({ clientId: 'abc', name: 'Renamed', isProduction: false });
    expect(result.ok).toBe(true);
    const stored = await apps.findByClientId('abc');
    expect(stored?.name).toBe('Renamed');
    expect(stored?.updatedAt).toEqual(NOW);
  });

  it.each(['Shop <hello@a.example>', 'hello@a.example\r\nBcc: x@evil.example', 'hello'])(
    'rejects the invalid email_from %j and changes nothing',
    async (emailFrom) => {
      const result = await update.execute({ clientId: 'abc', emailFrom, name: 'Changed', isProduction: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_email_from');
      const stored = await apps.findByClientId('abc');
      expect(stored?.name).toBe('Shop');
    },
  );

  it('sets a valid email_from and clears it with null', async () => {
    await update.execute({ clientId: 'abc', emailFrom: 'hello@a.example', isProduction: false });
    expect((await apps.findByClientId('abc'))?.emailFrom).toBe('hello@a.example');
    await update.execute({ clientId: 'abc', emailFrom: null, isProduction: false });
    expect((await apps.findByClientId('abc'))?.emailFrom).toBeNull();
  });

  it('normalizes updated origins and keeps redirect uris verbatim', async () => {
    const result = await update.execute({
      clientId: 'abc',
      allowedOrigins: ['HTTPS://B.example', 'https://b.example'],
      redirectUris: ['https://b.example/Cb'],
      isProduction: false,
    });
    expect(result.ok).toBe(true);
    const stored = await apps.findByClientId('abc');
    expect(stored?.allowedOrigins).toEqual(['https://b.example']);
    expect(stored?.redirectUris).toEqual(['https://b.example/Cb']);
  });

  it.each(['https://a.example/', 'https://a.example/app', 'null', '*', 'http://a.example'])(
    'rejects the invalid origin %s and changes nothing',
    async (origin) => {
      const result = await update.execute({ clientId: 'abc', allowedOrigins: [origin], name: 'Changed', isProduction: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_allowed_origin');
      const stored = await apps.findByClientId('abc');
      expect(stored?.allowedOrigins).toEqual(['https://a.example']);
      expect(stored?.name).toBe('Shop');
    },
  );

  it.each(['/cb', 'https://a.example/cb#x', 'http://a.example/cb'])(
    'rejects the invalid redirect uri %s and changes nothing',
    async (uri) => {
      const result = await update.execute({ clientId: 'abc', redirectUris: [uri], name: 'Changed', isProduction: false });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_redirect_uri');
      const stored = await apps.findByClientId('abc');
      expect(stored?.redirectUris).toEqual(['https://a.example/cb']);
      expect(stored?.name).toBe('Shop');
    },
  );

  it('rejects http localhost in production and accepts it otherwise', async () => {
    const prod = await update.execute({ clientId: 'abc', redirectUris: ['http://localhost:3000/cb'], isProduction: true });
    expect(prod.ok).toBe(false);
    const dev = await update.execute({ clientId: 'abc', redirectUris: ['http://localhost:3000/cb'], isProduction: false });
    expect(dev.ok).toBe(true);
  });

  it('reports app_not_found for an unknown client_id', async () => {
    const result = await update.execute({ clientId: 'zzz', name: 'x', isProduction: false });
    expect(!result.ok && result.error.code).toBe('app_not_found');
  });

  it('deactivates an app', async () => {
    const result = await deactivate.execute({ clientId: 'abc' });
    expect(result.ok).toBe(true);
    expect((await apps.findByClientId('abc'))?.isActive()).toBe(false);
  });

  it('reports app_not_found when deactivating an unknown client_id', async () => {
    const result = await deactivate.execute({ clientId: 'zzz' });
    expect(!result.ok && result.error.code).toBe('app_not_found');
  });
});
