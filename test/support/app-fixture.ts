import { App, type AppProps } from '../../src/app-registry/domain/app';

const NOW = new Date('2026-01-01T00:00:00.000Z');

/** A resolved, active app for tests that need a `ClientRef`. Pass a distinct `id` to get a distinct client. */
export const anApp = (overrides: Partial<AppProps> = {}): App =>
  App.restore({
    id: '11111111-1111-4111-8111-111111111111',
    clientId: 'shop',
    name: 'Shop',
    clientType: 'public',
    clientSecretHash: null,
    redirectUris: ['https://shop.example/cb'],
    allowedOrigins: [],
    emailFrom: null,
    emailConfirmationUrl: null,
    passwordResetUrl: null,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
