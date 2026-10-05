import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { TokenLifecycleModule } from './token-lifecycle.module';
import { generateKeySet } from './infrastructure/signing-key-generator';
import { SIGNING_KEYS_SOURCE, signingKeysFromEnv, type SigningKeysSource } from './infrastructure/signing-keys-source';

function configModule() {
  const config = { authPublicBaseUrl: 'http://localhost:3000' } as AppConfig;
  @Global()
  @Module({ providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] })
  class ConfigStub {}
  return ConfigStub;
}

describe('TokenLifecycleModule boot', () => {
  const compile = (source: SigningKeysSource) =>
    Test.createTestingModule({ imports: [configModule(), SharedKernelModule, TokenLifecycleModule] })
      .overrideProvider(SIGNING_KEYS_SOURCE)
      .useValue(source)
      .compile();

  it('starts with a valid key set', async () => {
    await expect(compile(() => JSON.stringify(generateKeySet()))).resolves.toBeDefined();
  });

  it('refuses to start when no signing key variable is set, with a clear error', async () => {
    const boot = compile(() => signingKeysFromEnv({}));

    await expect(boot).rejects.toThrow('set exactly one of AUTH_SIGNING_KEYS and AUTH_SIGNING_KEYS_FILE');
  });

  it('refuses to start when the key file cannot be read, naming only the variable', async () => {
    const boot = compile(() => signingKeysFromEnv({ AUTH_SIGNING_KEYS_FILE: '/nonexistent/secret-dir/keys.json' }));

    await expect(boot).rejects.toThrow('AUTH_SIGNING_KEYS_FILE: cannot read the file');
    await expect(boot).rejects.not.toThrow('secret-dir');
  });

  it('refuses to start with an invalid key set and does not echo the key material', async () => {
    const set = generateKeySet({ next: false });
    const marker = String(set.active.n);
    const boot = compile(() => JSON.stringify({ active: { ...set.active, kty: 'EC' } }));

    await expect(boot).rejects.toThrow('Invalid signing key set: active.kty');
    await expect(boot).rejects.not.toThrow(marker);
  });
});
