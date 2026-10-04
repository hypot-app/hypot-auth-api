import { InMemoryAppRepository } from '../../../test/support/in-memory-app.repository';
import { FixedClock } from '../../shared-kernel/clock';
import { App } from '../domain/app';
import { IsOriginAllowedUseCase } from './is-origin-allowed.use-case';

function app(origins: string[], status: 'active' | 'inactive' = 'active'): App {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return App.restore({
    id: crypto.randomUUID(),
    clientId: `app_${crypto.randomUUID()}`,
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: [],
    allowedOrigins: origins,
    emailFrom: null,
    postResetRedirectUri: null,
    status,
    createdAt: now,
    updatedAt: now,
  });
}

describe('IsOriginAllowedUseCase', () => {
  const TTL_MS = 30_000;
  let apps: InMemoryAppRepository;
  let clock: FixedClock;
  let useCase: IsOriginAllowedUseCase;

  beforeEach(() => {
    apps = new InMemoryAppRepository();
    clock = new FixedClock(new Date('2026-03-03T10:00:00.000Z'));
    useCase = new IsOriginAllowedUseCase({ apps, clock, ttlMs: TTL_MS, maxEntries: 3 });
  });

  it('allows an origin listed by an active app and denies any other', async () => {
    await apps.save(app(['https://a.example']));

    expect(await useCase.execute('https://a.example')).toBe(true);
    expect(await useCase.execute('https://other.example')).toBe(false);
  });

  it('denies the origin of an inactive app', async () => {
    await apps.save(app(['https://off.example'], 'inactive'));

    expect(await useCase.execute('https://off.example')).toBe(false);
  });

  it('serves repeated checks from the cache within the TTL', async () => {
    await apps.save(app(['https://a.example']));
    const spy = jest.spyOn(apps, 'isOriginAllowed');

    await useCase.execute('https://a.example');
    await useCase.execute('https://a.example');
    await useCase.execute('https://nope.example');
    await useCase.execute('https://nope.example');

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps serving a cached answer until the TTL elapses, then re-checks', async () => {
    const a = app(['https://a.example']);
    await apps.save(a);
    expect(await useCase.execute('https://a.example')).toBe(true);

    await apps.save(a.deactivate(clock.now()));
    clock.advanceMs(TTL_MS - 1);
    expect(await useCase.execute('https://a.example')).toBe(true);

    clock.advanceMs(1);
    expect(await useCase.execute('https://a.example')).toBe(false);
  });

  it('stays bounded: past maxEntries the cache is dropped, answers stay correct', async () => {
    await apps.save(app(['https://a.example']));
    for (const origin of ['https://1.example', 'https://2.example', 'https://3.example', 'https://4.example']) {
      expect(await useCase.execute(origin)).toBe(false);
    }
    expect(await useCase.execute('https://a.example')).toBe(true);
  });
});
