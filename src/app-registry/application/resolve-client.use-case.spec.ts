import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { App, type AppProps } from '../domain/app';
import { ResolveClientUseCase } from './resolve-client.use-case';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const appProps = (overrides: Partial<AppProps> = {}): AppProps => ({
  id: '11111111-1111-4111-8111-111111111111',
  clientId: 'abc',
  name: 'Shop',
  clientType: 'public',
  clientSecretHash: null,
  redirectUris: ['https://a.example/cb'],
  allowedOrigins: [],
  emailFrom: null,
  emailConfirmationUrl: null,
  passwordResetUrl: null,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('ResolveClientUseCase', () => {
  let apps: InMemoryAppRepository;
  let useCase: ResolveClientUseCase;

  beforeEach(async () => {
    apps = new InMemoryAppRepository();
    useCase = new ResolveClientUseCase(apps);
    await apps.save(App.restore(appProps()));
    await apps.save(App.restore(appProps({ id: '22222222-2222-4222-8222-222222222222', clientId: 'off', status: 'inactive' })));
  });

  describe('origin binding', () => {
    beforeEach(async () => {
      await apps.save(App.restore(appProps({ clientId: 'abc', allowedOrigins: ['https://a.example'] })));
      await apps.save(
        App.restore(
          appProps({ id: '33333333-3333-4333-8333-333333333333', clientId: 'other', allowedOrigins: ['https://b.example'] }),
        ),
      );
      await apps.save(
        App.restore(
          appProps({
            id: '22222222-2222-4222-8222-222222222222',
            clientId: 'off',
            status: 'inactive',
            allowedOrigins: ['https://a.example'],
          }),
        ),
      );
    });

    it('skips the binding when there is no origin (native and server callers)', async () => {
      const result = await useCase.execute({ clientId: 'abc' });
      expect(result.ok && result.value.clientId).toBe('abc');
    });

    it("accepts the app's own origin", async () => {
      const result = await useCase.execute({ clientId: 'abc', origin: 'https://a.example' });
      expect(result.ok && result.value.clientId).toBe('abc');
    });

    it('refuses the origin of another active app with the same error as an unknown client', async () => {
      const unknown = await useCase.execute({ clientId: 'zzz', origin: 'https://a.example' });
      const wrongApp = await useCase.execute({ clientId: 'abc', origin: 'https://b.example' });
      expect(wrongApp.ok).toBe(false);
      if (!wrongApp.ok && !unknown.ok) {
        expect(wrongApp.error.code).toBe('invalid_client');
        expect(wrongApp.error.message).toBe(unknown.error.message);
      }
    });

    it.each(['https://A.example', 'https://a.example/', 'http://a.example', 'https://a.example:443', 'null', ''])(
      'compares exactly: %j is not the app origin',
      async (origin) => {
        const result = await useCase.execute({ clientId: 'abc', origin });
        expect(!result.ok && result.error.code).toBe('invalid_client');
      },
    );
  });

  it('resolves an active app by client_id', async () => {
    const result = await useCase.execute({ clientId: 'abc' });
    expect(result.ok && result.value.clientId).toBe('abc');
  });

  it('returns a generic invalid_client for an unknown client_id', async () => {
    const result = await useCase.execute({ clientId: 'zzz' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_client');
  });

  it('returns the same invalid_client error (code and message) for an inactive app', async () => {
    const unknown = await useCase.execute({ clientId: 'zzz' });
    const inactive = await useCase.execute({ clientId: 'off' });
    expect(inactive.ok).toBe(false);
    if (!inactive.ok && !unknown.ok) {
      expect(inactive.error.code).toBe(unknown.error.code);
      expect(inactive.error.message).toBe(unknown.error.message);
    }
  });

  it('accepts a redirect_uri that exactly matches a registered one', async () => {
    const result = await useCase.execute({ clientId: 'abc', redirectUri: 'https://a.example/cb' });
    expect(result.ok).toBe(true);
  });

  it.each(['https://evil.example/cb', 'https://a.example/cb/', 'https://a.example/*'])(
    'rejects the unregistered redirect_uri %s',
    async (redirectUri) => {
      const result = await useCase.execute({ clientId: 'abc', redirectUri });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('invalid_redirect_uri');
    },
  );

  it('checks the client before the redirect_uri (unknown client wins)', async () => {
    const result = await useCase.execute({ clientId: 'zzz', redirectUri: 'https://a.example/cb' });
    expect(!result.ok && result.error.code).toBe('invalid_client');
  });
});
