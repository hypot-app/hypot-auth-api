import type { AbuseGuard } from '../../abuse-protection/application/abuse-guard';
import type { ClientIp } from '../../abuse-protection/domain/client-ip';
import { ClientRef } from '../../abuse-protection/domain/client-ref';
import { RateLimitedError } from '../../abuse-protection/domain/rate-limited-error';
import type { ResolveClientUseCase } from '../../app-registry/application/resolve-client.use-case';
import type { App } from '../../app-registry/domain/app';
import { DomainError } from '../../shared-kernel/domain-error';
import { err, ok, type Result } from '../../shared-kernel/result';

export interface EmailRequestGateDeps {
  resolveClient: ResolveClientUseCase;
  abuse: AbuseGuard;
}

export interface EmailRequest {
  clientId: string;
  /** Browser `Origin` header, when present; it must belong to the app (ADR 38). */
  origin?: string;
  ip: ClientIp;
}

export interface AdmittedEmailRequest {
  app: App;
  /** The limiter identity of the resolved app, for the per-account cap. */
  client: ClientRef;
}

/**
 * What every request that may send an account email (signup, resend, later forgot) checks first, before any
 * account lookup and before bcrypt: the client with its origin binding, the per-IP limit, and that the
 * app has both email link URLs.
 *
 * The IP limit is keyed by the resolved app, or by the shared sentinel for an unknown client, so a random
 * `client_id` cannot mint a fresh counter. It runs before the client is rejected, so probing with unknown
 * clients is throttled too. The decision depends only on the IP and the app, never on account state.
 */
export async function admitEmailRequest(
  deps: EmailRequestGateDeps,
  request: EmailRequest,
): Promise<Result<AdmittedEmailRequest, DomainError>> {
  const resolved = await deps.resolveClient.execute({ clientId: request.clientId, origin: request.origin });
  const client = resolved.ok ? ClientRef.resolved(resolved.value) : ClientRef.unknown();

  const decision = await deps.abuse.checkClientIp('email_ip', client, request.ip);
  if (decision.kind === 'ip_limited') return err(new RateLimitedError(decision.retryAfterSeconds));
  if (!resolved.ok) return err(resolved.error);

  const app = resolved.value;
  if (!app.hasEmailLinks()) {
    // The error describes the app, never an account (ADR 39).
    return err(new DomainError('unconfigured_client', 'This client is not configured to send email'));
  }
  return ok({ app, client });
}
