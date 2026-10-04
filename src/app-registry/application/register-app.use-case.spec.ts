import { InMemoryAppRepository, PassThroughUnitOfWork } from '../../../test/support/in-memory-app.repository';
import { FixedClock } from '../../shared-kernel/clock';
import { CryptoTokenGenerator, hashToken } from '../../shared-kernel/token-generator';
import type { IdGenerator } from './id-generator';
import { RegisterAppUseCase, type RegisterAppInput } from './register-app.use-case';

class SequentialIds implements IdGenerator {
  private n = 0;
  appId(): string {
    return `00000000-0000-4000-8000-${String(++this.n).padStart(12, '0')}`;
  }
  clientId(): string {
    return `client-${this.n}`;
  }
}

describe('RegisterAppUseCase', () => {
  const now = new Date('2026-03-03T10:00:00.000Z');
  let apps: InMemoryAppRepository;
  let useCase: RegisterAppUseCase;

  const input = (overrides: Partial<RegisterAppInput> = {}): RegisterAppInput => ({
    name: 'Shop',
    clientType: 'public',
    redirectUris: ['https://a.example/cb'],
    allowedOrigins: ['https://a.example'],
    isProduction: false,
    ...overrides,
  });

  beforeEach(() => {
    apps = new InMemoryAppRepository();
    useCase = new RegisterAppUseCase({
      apps,
      tokens: new CryptoTokenGenerator(),
      clock: new FixedClock(now),
      ids: new SequentialIds(),
      uow: new PassThroughUnitOfWork(),
    });
  });

  it('registers a public app with a generated client_id and no secret', async () => {
    const result = await useCase.execute(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientSecret).toBeNull();
    expect(result.value.app.clientType).toBe('public');
    expect(result.value.app.clientId).toBe('client-1');
    expect(result.value.app.clientSecretHash).toBeNull();
    expect(result.value.app.isActive()).toBe(true);
    expect(result.value.app.createdAt).toEqual(now);
    expect(await apps.findByClientId('client-1')).toBe(result.value.app);
  });

  it('registers a confidential app: secret returned once, only its SHA-256 hash stored', async () => {
    const result = await useCase.execute(input({ clientType: 'confidential' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const secret = result.value.clientSecret;
    expect(secret).toEqual(expect.any(String));
    expect(Buffer.from(secret as string, 'base64url').length).toBeGreaterThanOrEqual(32);

    const stored = await apps.findByClientId(result.value.app.clientId);
    expect(stored?.clientSecretHash?.equals(hashToken(secret as string))).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(secret as string);
  });

  it('generates a different secret for every confidential app', async () => {
    const a = await useCase.execute(input({ clientType: 'confidential' }));
    const b = await useCase.execute(input({ clientType: 'confidential' }));
    expect(a.ok && b.ok && a.value.clientSecret !== b.value.clientSecret).toBe(true);
  });

  it('stores a valid post_reset_redirect_uri as given', async () => {
    const result = await useCase.execute(input({ postResetRedirectUri: 'https://a.example/login' }));
    expect(result.ok && result.value.app.postResetRedirectUri).toBe('https://a.example/login');
  });

  it('stores null when the post_reset_redirect_uri is omitted', async () => {
    const result = await useCase.execute(input());
    expect(result.ok && result.value.app.postResetRedirectUri).toBeNull();
  });

  it('keeps the optional email_from', async () => {
    const result = await useCase.execute(input({ emailFrom: 'no-reply@a.example' }));
    expect(result.ok && result.value.app.emailFrom).toBe('no-reply@a.example');
  });

  it.each([
    ['a display name', 'Shop <hello@a.example>'],
    ['CRLF header injection', 'hello@a.example\r\nBcc: x@evil.example'],
    ['a list', 'a@a.example, b@a.example'],
    ['not an address', 'hello'],
  ])('rejects an invalid email_from (%s) and persists nothing', async (_label, emailFrom) => {
    const result = await useCase.execute(input({ emailFrom }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_email_from');
    expect(apps.apps.size).toBe(0);
  });

  it.each([
    ['relative', '/login'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['plain http on a public host', 'http://a.example/login'],
    ['userinfo', 'https://u:p@a.example/login'],
    ['fragment', 'https://a.example/login#x'],
  ])('rejects an invalid post_reset_redirect_uri (%s) and persists nothing', async (_label, uri) => {
    const result = await useCase.execute(input({ postResetRedirectUri: uri, clientType: 'confidential' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_post_reset_redirect_uri');
    expect(apps.apps.size).toBe(0);
  });

  it('accepts http://localhost outside production and rejects it in production', async () => {
    const dev = await useCase.execute(input({ postResetRedirectUri: 'http://localhost:3000/login' }));
    expect(dev.ok).toBe(true);

    const prod = await useCase.execute(
      input({ postResetRedirectUri: 'http://localhost:3000/login', isProduction: true }),
    );
    expect(prod.ok).toBe(false);
    expect(apps.apps.size).toBe(1);
  });

  it('normalizes allowed origins (lower-case, de-duplicated) before storing them', async () => {
    const result = await useCase.execute(
      input({ allowedOrigins: ['HTTPS://Shop.Example', 'https://shop.example', 'http://localhost:5173'] }),
    );
    expect(result.ok && result.value.app.allowedOrigins).toEqual(['https://shop.example', 'http://localhost:5173']);
  });

  it.each([
    ['a trailing slash', 'https://a.example/'],
    ['a path', 'https://a.example/app'],
    ['the null origin', 'null'],
    ['a wildcard', '*'],
    ['plain http on a public host', 'http://a.example'],
  ])('rejects an invalid allowed origin (%s) and persists nothing', async (_label, origin) => {
    const result = await useCase.execute(
      input({ allowedOrigins: ['https://ok.example', origin], clientType: 'confidential' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_allowed_origin');
    expect(apps.apps.size).toBe(0);
  });

  it('rejects http localhost origins in production', async () => {
    const result = await useCase.execute(input({ allowedOrigins: ['http://localhost:3000'], isProduction: true }));
    expect(result.ok).toBe(false);
    expect(apps.apps.size).toBe(0);
  });

  it.each([
    ['relative', '/cb'],
    ['a fragment', 'https://a.example/cb#x'],
    ['plain http on a public host', 'http://a.example/cb'],
    ['a custom scheme', 'myapp://cb'],
  ])('rejects an invalid redirect uri (%s) and persists nothing', async (_label, uri) => {
    const result = await useCase.execute(input({ redirectUris: ['https://a.example/cb', uri] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid_redirect_uri');
    expect(apps.apps.size).toBe(0);
  });

  it('accepts http localhost redirect uris outside production only', async () => {
    const dev = await useCase.execute(input({ redirectUris: ['http://localhost:3000/cb'] }));
    expect(dev.ok).toBe(true);
    const prod = await useCase.execute(input({ redirectUris: ['http://localhost:3000/cb'], isProduction: true }));
    expect(prod.ok).toBe(false);
  });

  it('rejects a blank name and persists nothing', async () => {
    const result = await useCase.execute(input({ name: ' ' }));
    expect(result.ok).toBe(false);
    expect(apps.apps.size).toBe(0);
  });
});
