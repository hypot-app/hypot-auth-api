import type { User } from '../domain/user';

/** The body of `GET /me`: identity only. Auth stores no name or profile; apps link their own data by `id`. */
export interface ProfileResponse {
  id: string;
  email: string;
  email_verified: boolean;
  /** ISO 8601 UTC. */
  created_at: string;
}

/** An explicit field list, so a column added to the account later never reaches the wire by accident. */
export function toProfileResponse(user: User): ProfileResponse {
  return {
    id: user.id,
    email: user.email,
    email_verified: user.isConfirmed(),
    created_at: user.createdAt.toISOString(),
  };
}
