import { API_PREFIX } from '../../shared-kernel/api-prefix';

/**
 * Builds every link that goes into an email. The base is the single global
 * AUTH_PUBLIC_BASE_URL (ADR 24); apps never supply one. All links target the
 * versioned API (ADR 28). Values are percent-encoded so they cannot add or
 * break query parameters.
 */
export class EmailLinks {
  private readonly root: string;

  /** `baseUrl` is already validated by config: absolute http(s), no trailing slash. */
  constructor(baseUrl: string) {
    this.root = `${baseUrl}/${API_PREFIX}`;
  }

  confirmation(token: string): string {
    return `${this.root}/accounts/confirm?token=${encodeURIComponent(token)}`;
  }

  passwordReset(token: string, clientId: string): string {
    return `${this.root}/password/reset?token=${encodeURIComponent(token)}&client_id=${encodeURIComponent(clientId)}`;
  }

  /** Deep link for the account-exists notice. Carries only the public client_id, never a token. */
  accountExists(clientId: string): string {
    return `${this.root}/password/forgot?client_id=${encodeURIComponent(clientId)}`;
  }
}
