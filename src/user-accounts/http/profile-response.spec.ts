import { User } from '../domain/user';
import { toProfileResponse } from './profile-response';

const T0 = new Date('2026-03-03T10:00:00.123Z');
const aUser = (): User =>
  User.register({
    id: '11111111-1111-4111-8111-111111111111',
    appId: '22222222-2222-4222-8222-222222222222',
    email: 'ana@example.com',
    passwordHash: '$2b$12$secret-hash',
    now: T0,
  });

describe('toProfileResponse', () => {
  it('exposes exactly id, email, email_verified and created_at, and nothing else', () => {
    const profile = toProfileResponse(aUser());

    expect(Object.keys(profile).sort()).toEqual(['created_at', 'email', 'email_verified', 'id']);
    expect(JSON.stringify(profile)).not.toContain('secret-hash');
  });

  it('maps an unconfirmed account to email_verified false and a confirmed one to true', () => {
    expect(toProfileResponse(aUser()).email_verified).toBe(false);
    expect(toProfileResponse(aUser().confirm(new Date('2026-03-04T00:00:00Z'))).email_verified).toBe(true);
  });

  it('formats created_at as ISO 8601 UTC and keeps id and the stored lowercase email', () => {
    expect(toProfileResponse(aUser())).toEqual({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'ana@example.com',
      email_verified: false,
      created_at: '2026-03-03T10:00:00.123Z',
    });
  });
});
