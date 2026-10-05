export interface UserProps {
  id: string;
  appId: string;
  /** Normalized (trimmed, lowercase); see normalizeEmail. */
  email: string;
  /** Output of the PasswordHasher. Never leaves the service. */
  passwordHash: string;
  /** Null until the owner confirms the address. */
  emailVerifiedAt: Date | null;
  passwordChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** An account in one app. Plain TypeScript: no framework or persistence imports. */
export class User implements UserProps {
  readonly id: string;
  readonly appId: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly emailVerifiedAt: Date | null;
  readonly passwordChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  private constructor(props: UserProps) {
    this.id = props.id;
    this.appId = props.appId;
    this.email = props.email;
    this.passwordHash = props.passwordHash;
    this.emailVerifiedAt = props.emailVerifiedAt;
    this.passwordChangedAt = props.passwordChangedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /** A new, unconfirmed account. `email` must already be normalized. */
  static register(input: { id: string; appId: string; email: string; passwordHash: string; now: Date }): User {
    return new User({
      id: input.id,
      appId: input.appId,
      email: input.email,
      passwordHash: input.passwordHash,
      emailVerifiedAt: null,
      passwordChangedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** Rebuilds an account that was already validated and stored. */
  static restore(props: UserProps): User {
    return new User(props);
  }

  /** Returns a confirmed copy. Confirming again keeps the first confirmation time. */
  confirm(now: Date): User {
    if (this.isConfirmed()) return this;
    return new User({ ...this, emailVerifiedAt: now, updatedAt: now });
  }

  isConfirmed(): boolean {
    return this.emailVerifiedAt !== null;
  }
}
