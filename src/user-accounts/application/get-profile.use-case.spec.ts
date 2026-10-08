import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';
import type { AuthenticateBearerInput, AuthenticatedBearer } from '../../token-lifecycle/application/authenticate-bearer.use-case';
import { InMemoryUserRepository } from '../../../test/support/in-memory-user-accounts';
import { User } from '../domain/user';
import { GetProfileUseCase } from './get-profile.use-case';

const T0 = new Date('2026-03-03T10:00:00.000Z');
const APP_A = '11111111-1111-4111-8111-111111111111';
const APP_B = '22222222-2222-4222-8222-222222222222';
const ANA = '33333333-3333-4333-8333-333333333333';
const BEA = '44444444-4444-4444-8444-444444444444';

function setup(bearer: Result<AuthenticatedBearer, DomainError>) {
  const users = new InMemoryUserRepository();
  const seen: AuthenticateBearerInput[] = [];
  const authenticate = {
    execute: async (input: AuthenticateBearerInput) => {
      seen.push(input);
      return bearer;
    },
  };
  const useCase = new GetProfileUseCase({ authenticate, users });
  const add = (id: string, appId: string, email: string) =>
    users.add(User.register({ id, appId, email, passwordHash: 'hash', now: T0 }));
  return { useCase, seen, add, run: () => useCase.execute({ authorization: 'Bearer t', origin: 'https://shop.example' }) };
}

const bearerOf = (accountId: string, appId = APP_A) => ok({ accountId, appId, clientId: 'app_a' });
const UNAUTHORIZED = err(new DomainError('unauthorized', 'Missing or invalid access token'));

describe('GetProfileUseCase', () => {
  it('returns the account of the token, and passes the header and origin on to the bearer check', async () => {
    const t = setup(bearerOf(ANA));
    await t.add(ANA, APP_A, 'ana@example.com');
    await t.add(BEA, APP_A, 'bea@example.com');

    const result = await t.run();

    expect(result.ok && result.value.email).toBe('ana@example.com');
    expect(result.ok && result.value.id).toBe(ANA);
    expect(t.seen).toEqual([{ authorization: 'Bearer t', origin: 'https://shop.example' }]);
  });

  it('is unauthorized when the bearer check fails, and reads no account', async () => {
    const t = setup(UNAUTHORIZED);
    await t.add(ANA, APP_A, 'ana@example.com');

    expect(await t.run()).toEqual(UNAUTHORIZED);
  });

  it('is the same unauthorized for an account that does not exist', async () => {
    const t = setup(bearerOf(ANA));

    expect(await t.run()).toEqual(UNAUTHORIZED);
  });

  it('is unauthorized when the account belongs to another app than the token', async () => {
    const t = setup(bearerOf(ANA, APP_A));
    await t.add(ANA, APP_B, 'ana@example.com');

    expect(await t.run()).toEqual(UNAUTHORIZED);
  });
});
