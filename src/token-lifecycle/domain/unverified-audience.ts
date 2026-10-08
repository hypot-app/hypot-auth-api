/** Same bound as the `client_id` of a request body: a longer value cannot name an app. */
const MAX_AUDIENCE_LENGTH = 128;

/**
 * Reads the `aud` claim of a JWT WITHOUT verifying it. The value only selects which audience to
 * expect (ADR 32 flow); it is never trusted, and the verifier still checks it against the signature.
 * Returns null unless `aud` is a single non-empty string, which is the only shape this service issues.
 */
export function unverifiedAudience(token: string): string | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const aud = (payload as { aud?: unknown }).aud;
    if (typeof aud !== 'string' || aud.length === 0 || aud.length > MAX_AUDIENCE_LENGTH) return null;
    return aud;
  } catch {
    return null;
  }
}
