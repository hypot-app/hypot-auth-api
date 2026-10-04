import { EmailLinks } from './email-links';

const links = new EmailLinks('https://auth.example.com');

describe('EmailLinks', () => {
  it('builds the confirmation link under /api/v1 on the configured base', () => {
    expect(links.confirmation('tok_123')).toBe('https://auth.example.com/api/v1/accounts/confirm?token=tok_123');
  });

  it('builds the reset link with the token and the app client_id', () => {
    expect(links.passwordReset('tok_123', 'app_abc')).toBe(
      'https://auth.example.com/api/v1/password/reset?token=tok_123&client_id=app_abc',
    );
  });

  it('builds the account-exists link with only the client_id', () => {
    expect(links.accountExists('app_abc')).toBe('https://auth.example.com/api/v1/password/forgot?client_id=app_abc');
  });

  it('keeps a base URL with a port and uses it verbatim', () => {
    expect(new EmailLinks('http://localhost:3000').accountExists('app_x')).toBe(
      'http://localhost:3000/api/v1/password/forgot?client_id=app_x',
    );
  });

  it('percent-encodes values so they cannot add or break query parameters', () => {
    expect(links.confirmation('a&b=c#d')).toBe('https://auth.example.com/api/v1/accounts/confirm?token=a%26b%3Dc%23d');
    expect(links.accountExists('x&y')).toBe('https://auth.example.com/api/v1/password/forgot?client_id=x%26y');
  });
});
