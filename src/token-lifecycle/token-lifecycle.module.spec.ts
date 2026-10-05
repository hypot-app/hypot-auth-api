import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config';
import { SharedKernelModule } from '../shared-kernel/shared-kernel.module';
import { TokenLifecycleModule } from './token-lifecycle.module';
import { generateKeySet } from './infrastructure/signing-key-generator';

function configModule(signingKeysJson: string) {
  const config = { signingKeysJson, authPublicBaseUrl: 'http://localhost:3000' } as AppConfig;
  @Global()
  @Module({ providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] })
  class ConfigStub {}
  return ConfigStub;
}

describe('TokenLifecycleModule boot', () => {
  const compile = (signingKeysJson: string) =>
    Test.createTestingModule({ imports: [configModule(signingKeysJson), SharedKernelModule, TokenLifecycleModule] }).compile();

  it('starts with a valid key set', async () => {
    await expect(compile(JSON.stringify(generateKeySet()))).resolves.toBeDefined();
  });

  it('refuses to start with an invalid key set and does not echo the key material', async () => {
    const set = generateKeySet({ next: false });
    const marker = String(set.active.n);
    const boot = compile(JSON.stringify({ active: { ...set.active, kty: 'EC' } }));

    await expect(boot).rejects.toThrow('Invalid signing key set: active.kty');
    await expect(boot).rejects.not.toThrow(marker);
  });
});
