import { OneTimeToken, type OneTimeTokenPurpose } from '../../src/user-accounts/domain/one-time-token';
import type { OneTimeTokenRepository, TokenApp } from '../../src/user-accounts/domain/one-time-token.repository';
import type { PasswordHasher } from '../../src/user-accounts/domain/password-hasher';
import { User } from '../../src/user-accounts/domain/user';
import type { UserRepository } from '../../src/user-accounts/domain/user.repository';

/** Unit-test double for UserRepository with the same uniqueness rule as the SQL one. */
export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, User>();

  async add(user: User): Promise<boolean> {
    const taken = [...this.users.values()].some((u) => u.appId === user.appId && u.email.toLowerCase() === user.email.toLowerCase());
    if (taken) return false;
    this.users.set(user.id, user);
    return true;
  }

  async markEmailVerified(userId: string, at: Date): Promise<void> {
    const user = this.users.get(userId);
    if (user !== undefined) this.users.set(userId, user.confirm(at));
  }

  async updatePassword(userId: string, passwordHash: string, at: Date): Promise<boolean> {
    const user = this.users.get(userId);
    if (user === undefined) return false;
    this.users.set(userId, User.restore({ ...user, passwordHash, passwordChangedAt: at, updatedAt: at }));
    return true;
  }

  async replacePassword(userId: string, currentHash: string, newHash: string, at: Date): Promise<boolean> {
    const user = this.users.get(userId);
    if (user === undefined || user.passwordHash !== currentHash) return false;
    return this.updatePassword(userId, newHash, at);
  }

  async findByAppAndEmail(appId: string, email: string): Promise<User | null> {
    return [...this.users.values()].find((u) => u.appId === appId && u.email === email) ?? null;
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async findByIdInApp(appId: string, id: string): Promise<User | null> {
    const user = this.users.get(id);
    return user !== undefined && user.appId === appId ? user : null;
  }
}

/** Unit-test double for OneTimeTokenRepository with the same consume rules as the SQL one. */
export class InMemoryOneTimeTokenRepository implements OneTimeTokenRepository {
  readonly tokens = new Map<string, OneTimeToken>();

  /** `appOfUser` stands in for the users and apps join of the SQL lookup. */
  constructor(private readonly appOfUser: (userId: string) => TokenApp | null = () => null) {}

  async save(token: OneTimeToken): Promise<void> {
    this.tokens.set(token.id, token);
  }

  async findAppByTokenHash(hash: Buffer, purpose: OneTimeTokenPurpose): Promise<TokenApp | null> {
    const found = [...this.tokens.values()].find((t) => t.tokenHash.equals(hash) && t.purpose === purpose);
    return found === undefined ? null : this.appOfUser(found.userId);
  }

  async consumeByHash(hash: Buffer, purpose: OneTimeTokenPurpose, now: Date): Promise<OneTimeToken | null> {
    const found = [...this.tokens.values()].find(
      (t) => t.tokenHash.equals(hash) && t.purpose === purpose && t.consumedAt === null && t.expiresAt > now,
    );
    if (found === undefined) return null;
    const consumed = OneTimeToken.restore({ ...found, consumedAt: now });
    this.tokens.set(consumed.id, consumed);
    return consumed;
  }

  async invalidateOutstanding(userId: string, purpose: OneTimeTokenPurpose, now: Date): Promise<void> {
    for (const token of this.tokens.values()) {
      if (token.userId === userId && token.purpose === purpose && token.consumedAt === null) {
        this.tokens.set(token.id, OneTimeToken.restore({ ...token, consumedAt: now }));
      }
    }
  }
}

/** Fast stand-in for bcrypt that records how often it was asked to hash. */
export class FakePasswordHasher implements PasswordHasher {
  hashCalls = 0;
  verifyCalls = 0;

  async hash(password: string): Promise<string> {
    this.hashCalls += 1;
    return `hashed:${password}`;
  }

  async verify(password: string, hash: string): Promise<boolean> {
    this.verifyCalls += 1;
    return hash === `hashed:${password}`;
  }
}
