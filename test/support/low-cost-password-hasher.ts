import { hash } from 'bcrypt';
import { BcryptPasswordHasher } from '../../src/user-accounts/infrastructure/bcrypt-password-hasher';

/** bcrypt cost 4 (the minimum): real bcrypt format and comparison, about 1 ms per hash. For bulk e2e loops only. */
export const LOW_COST_BCRYPT = 4;

/**
 * Production `verify` (so `BcryptPasswordHasher.prototype.verify` spies still count calls) with a
 * cheap `hash`. `compare` reads the cost from the stored hash, so it also verifies cost-12 hashes, slowly.
 */
export class LowCostPasswordHasher extends BcryptPasswordHasher {
  override hash(password: string): Promise<string> {
    return hash(password, LOW_COST_BCRYPT);
  }
}
