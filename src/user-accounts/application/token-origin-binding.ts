import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { OneTimeTokenPurpose } from '../domain/one-time-token';
import type { OneTimeTokenRepository, TokenApp } from '../domain/one-time-token.repository';

export interface TokenOriginBindingDeps {
  resolveClient: ResolveClientUseCase;
  oneTimeTokens: Pick<OneTimeTokenRepository, 'findAppByTokenHash'>;
}

/**
 * Whether a browser `Origin` belongs to the app that owns a one-time token (ADR 38). Read-only and run before
 * the token is consumed, so a foreign page cannot burn a valid token. An unknown token and a wrong origin are
 * the same `false`, so the check is not a token oracle. Callers skip it when the request has no `Origin`.
 */
export async function originBoundToTokenApp(
  deps: TokenOriginBindingDeps,
  hash: Buffer,
  purpose: OneTimeTokenPurpose,
  origin: string,
): Promise<boolean> {
  const owner = await deps.oneTimeTokens.findAppByTokenHash(hash, purpose);
  return owner !== null && (await originBelongsToApp(deps.resolveClient, owner, origin));
}

/** The origin half of the check, for callers that already looked the token's app up. */
export async function originBelongsToApp(resolveClient: ResolveClientUseCase, owner: TokenApp, origin: string): Promise<boolean> {
  const client = await resolveClient.execute({ clientId: owner.clientId, origin });
  return client.ok;
}
