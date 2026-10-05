import { App, type AppProps } from '../../domain/app';
import { AppMapper } from './app.mapper';
import type { AppRow } from './app.schema';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const rowOf = (overrides: Partial<AppRow> = {}): AppRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  client_id: 'client-1',
  name: 'Shop',
  client_type: 'confidential',
  client_secret_hash: Buffer.alloc(32, 9),
  redirect_uris: ['https://a.example/cb'],
  allowed_origins: ['https://a.example'],
  email_from: 'no-reply@a.example',
  email_confirmation_url: 'https://a.example/confirm',
  password_reset_url: 'https://a.example/reset',
  status: 'inactive',
  created_at: NOW,
  updated_at: new Date('2026-02-02T00:00:00.000Z'),
  ...overrides,
});

describe('AppMapper', () => {
  it('maps a row to a domain App', () => {
    const app = AppMapper.toDomain(rowOf());
    expect(app.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(app.clientId).toBe('client-1');
    expect(app.clientType).toBe('confidential');
    expect(app.clientSecretHash?.equals(Buffer.alloc(32, 9))).toBe(true);
    expect(app.redirectUris).toEqual(['https://a.example/cb']);
    expect(app.allowedOrigins).toEqual(['https://a.example']);
    expect(app.emailFrom).toBe('no-reply@a.example');
    expect(app.emailConfirmationUrl).toBe('https://a.example/confirm');
    expect(app.passwordResetUrl).toBe('https://a.example/reset');
    expect(app.isActive()).toBe(false);
  });

  it('round-trips row -> domain -> row', () => {
    const row = rowOf();
    expect(AppMapper.toPersistence(AppMapper.toDomain(row))).toEqual(row);
  });

  it('round-trips the null case (public app, no email_from, no email link URLs)', () => {
    const row = rowOf({
      client_type: 'public',
      client_secret_hash: null,
      email_from: null,
      email_confirmation_url: null,
      password_reset_url: null,
      status: 'active',
    });
    const app = AppMapper.toDomain(row);
    expect(app.clientSecretHash).toBeNull();
    expect(app.emailConfirmationUrl).toBeNull();
    expect(app.passwordResetUrl).toBeNull();
    expect(AppMapper.toPersistence(app)).toEqual(row);
  });

  it('round-trips domain -> row -> domain', () => {
    const props: AppProps = {
      id: '22222222-2222-4222-8222-222222222222',
      clientId: 'client-2',
      name: 'Blog',
      clientType: 'public',
      clientSecretHash: null,
      redirectUris: ['https://b.example/cb'],
      allowedOrigins: [],
      emailFrom: null,
      emailConfirmationUrl: null,
      passwordResetUrl: null,
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    };
    const app = App.restore(props);
    expect(AppMapper.toDomain(AppMapper.toPersistence(app))).toEqual(app);
  });

  it('does not share array references between row and domain', () => {
    const row = rowOf();
    const app = AppMapper.toDomain(row);
    row.redirect_uris.push('https://evil.example/cb');
    expect(app.redirectUris).toEqual(['https://a.example/cb']);
  });
});
