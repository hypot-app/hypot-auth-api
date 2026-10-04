import { App, type AppProps } from '../../src/app-registry/domain/app';
import { AppSchema } from '../../src/app-registry/infrastructure/persistence/app.schema';
import { TypeOrmAppRepository } from '../../src/app-registry/infrastructure/persistence/typeorm-app.repository';
import { TypeOrmUnitOfWork } from '../../src/platform/persistence/typeorm-unit-of-work';
import { startTestDatabase, type TestDatabase } from '../support/postgres';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function props(overrides: Partial<AppProps> = {}): AppProps {
  return {
    id: crypto.randomUUID(),
    clientId: `client-${crypto.randomUUID()}`,
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: ['https://a.example/cb'],
    allowedOrigins: ['https://a.example'],
    emailFrom: null,
    postResetRedirectUri: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('TypeOrmAppRepository (integration)', () => {
  let db: TestDatabase;
  let repository: TypeOrmAppRepository;
  let uow: TypeOrmUnitOfWork;

  beforeAll(async () => {
    db = await startTestDatabase({ entities: [AppSchema] });
    repository = new TypeOrmAppRepository(db.dataSource);
    uow = new TypeOrmUnitOfWork(db.dataSource);
  }, 180_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  beforeEach(async () => {
    await db.truncate();
  });

  it('saves an app and finds it by client_id as a domain App', async () => {
    const app = App.restore(props({ clientId: 'abc', postResetRedirectUri: 'https://a.example/login' }));
    await repository.save(app);

    const found = await repository.findByClientId('abc');
    expect(found).toBeInstanceOf(App);
    expect(found).toEqual(app);
  });

  it('round-trips a confidential app with its secret hash', async () => {
    const app = App.restore(props({ clientId: 'conf', clientType: 'confidential', clientSecretHash: Buffer.alloc(32, 3) }));
    await repository.save(app);
    expect(await repository.findByClientId('conf')).toEqual(app);
  });

  it('returns null for an unknown client_id', async () => {
    expect(await repository.findByClientId('missing')).toBeNull();
  });

  it('updates an existing app when saved again', async () => {
    const original = props({ clientId: 'upd' });
    await repository.save(App.restore(original));
    await repository.save(App.restore({ ...original, name: 'Renamed', status: 'inactive' }));

    const found = await repository.findByClientId('upd');
    expect(found?.name).toBe('Renamed');
    expect(found?.isActive()).toBe(false);
  });

  it('fails on a duplicate client_id', async () => {
    await repository.save(App.restore(props({ clientId: 'dup' })));
    await expect(repository.save(App.restore(props({ clientId: 'dup' })))).rejects.toThrow(/duplicate key/);
  });

  it('joins the unit of work: a rollback discards the save', async () => {
    await expect(
      uow.run(async () => {
        await repository.save(App.restore(props({ clientId: 'rolled-back' })));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await repository.findByClientId('rolled-back')).toBeNull();
  });

  it('joins the unit of work: a commit keeps the save', async () => {
    await uow.run(async () => {
      await repository.save(App.restore(props({ clientId: 'committed' })));
    });
    expect(await repository.findByClientId('committed')).not.toBeNull();
  });
});
