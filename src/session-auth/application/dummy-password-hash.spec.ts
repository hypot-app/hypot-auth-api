import { BcryptPasswordHasher } from '../../user-accounts/infrastructure/bcrypt-password-hasher';
import { FakePasswordHasher } from '../../../test/support/in-memory-user-accounts';
import { createDummyPasswordHash } from './dummy-password-hash';

describe('createDummyPasswordHash', () => {
  it('hashes a long random secret, a different one on every boot', async () => {
    const hasher = new FakePasswordHasher();

    const first = await createDummyPasswordHash(hasher);
    const second = await createDummyPasswordHash(hasher);

    expect(first).toMatch(/^hashed:[0-9a-f]{32,}$/);
    expect(second).not.toBe(first);
  });

  it('costs the same as a real account: a bcrypt hash at cost 12, so comparing against it takes as long', async () => {
    const hash = await createDummyPasswordHash(new BcryptPasswordHasher());

    expect(hash).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  });
});
