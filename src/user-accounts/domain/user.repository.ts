import type { User } from './user';

/** Port: storage of accounts. Implementations join the current unit of work. */
export interface UserRepository {
  /**
   * Inserts a new account. Returns false, changing nothing, when the app already has
   * an account with that email (compared ignoring case). Atomic: two concurrent calls
   * for the same address cannot both return true.
   */
  add(user: User): Promise<boolean>;
  /**
   * Marks the address as confirmed at `at`, touching only the verification columns so a
   * concurrent change to anything else (a password reset) is never overwritten. A no-op
   * when the account is already confirmed or unknown: the first confirmation time is kept.
   */
  markEmailVerified(userId: string, at: Date): Promise<void>;
  /**
   * Replaces the password hash and `password_changed_at`, touching only those columns (and `updated_at`).
   * Returns false, changing nothing, when the account does not exist.
   */
  updatePassword(userId: string, passwordHash: string, at: Date): Promise<boolean>;
  /**
   * Compare-and-swap form of `updatePassword`: replaces the hash only while it is still `currentHash`, the one the
   * caller verified. Returns false, changing nothing, when the hash differs (another reset or change committed in
   * between) or the account does not exist. A password change uses it; a reset keeps the unconditional form
   * because its one-time token is the authority.
   */
  replacePassword(userId: string, currentHash: string, newHash: string, at: Date): Promise<boolean>;
  /** `email` must be normalized. */
  findByAppAndEmail(appId: string, email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  /** Like findById, but only when the account belongs to that app: an id of another app is not found. */
  findByIdInApp(appId: string, id: string): Promise<User | null>;
}

export const USER_REPOSITORY = Symbol('UserRepository');
