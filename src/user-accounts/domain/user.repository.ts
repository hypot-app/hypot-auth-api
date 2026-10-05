import type { User } from './user';

/** Port: storage of accounts. Implementations join the current unit of work. */
export interface UserRepository {
  /**
   * Inserts a new account. Returns false, changing nothing, when the app already has
   * an account with that email (compared ignoring case). Atomic: two concurrent calls
   * for the same address cannot both return true.
   */
  add(user: User): Promise<boolean>;
  /** Writes the changes of an existing account (matched by id). */
  save(user: User): Promise<void>;
  /** `email` must be normalized. */
  findByAppAndEmail(appId: string, email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
}

export const USER_REPOSITORY = Symbol('UserRepository');
