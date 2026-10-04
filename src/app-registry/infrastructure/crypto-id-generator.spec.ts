import { CryptoIdGenerator } from './crypto-id-generator';

describe('CryptoIdGenerator', () => {
  const ids = new CryptoIdGenerator();

  it('generates client ids as "app_" + 32 lowercase hex chars, so they never start with "-"', () => {
    for (let i = 0; i < 2000; i++) {
      const id = ids.clientId();
      expect(id).toMatch(/^app_[0-9a-f]{32}$/);
      expect(id.startsWith('-')).toBe(false);
    }
  });

  it('generates distinct client ids', () => {
    const seen = new Set(Array.from({ length: 500 }, () => ids.clientId()));
    expect(seen.size).toBe(500);
  });

  it('generates UUID app ids', () => {
    expect(ids.appId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
