import { User } from './user';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-02T00:00:00.000Z');

const registered = () =>
  User.register({ id: 'u1', appId: 'a1', email: 'ana@example.com', passwordHash: '$2b$12$hash', now: T0 });

describe('User', () => {
  it('registers unconfirmed with the creation time as password change time', () => {
    const user = registered();
    expect(user.isConfirmed()).toBe(false);
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordChangedAt).toEqual(T0);
    expect(user.createdAt).toEqual(T0);
    expect(user.updatedAt).toEqual(T0);
  });

  it('confirms into a new value and leaves the original unchanged', () => {
    const user = registered();
    const confirmed = user.confirm(T1);
    expect(confirmed.isConfirmed()).toBe(true);
    expect(confirmed.emailVerifiedAt).toEqual(T1);
    expect(confirmed.updatedAt).toEqual(T1);
    expect(user.isConfirmed()).toBe(false);
  });

  it('keeps the first confirmation time when confirmed again', () => {
    const confirmed = registered().confirm(T1);
    expect(confirmed.confirm(new Date('2026-02-01T00:00:00.000Z')).emailVerifiedAt).toEqual(T1);
  });
});
