import { BcryptPasswordHasher } from './bcrypt-password-hasher';

describe('BcryptPasswordHasher', () => {
  const hasher = new BcryptPasswordHasher();

  it('produces a bcrypt hash at cost 12', async () => {
    expect(await hasher.hash('correct horse')).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same password')).not.toBe(await hasher.hash('same password'));
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse');
    expect(await hasher.verify('correct horse', hash)).toBe(true);
    expect(await hasher.verify('wrong horse', hash)).toBe(false);
  });
});
