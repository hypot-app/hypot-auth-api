import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Sets `Cache-Control: no-store` and `Pragma: no-cache` before the handler runs, so the headers
 * are on every answer of the route: the token response (RFC 6749 section 5.1) and also its errors,
 * which keeps all answers of a route alike (the login failures stay byte-identical) and means no
 * handler can forget them. Apply it to a whole controller, so routes added later are covered.
 */
export function noStore(_req: IncomingMessage, res: ServerResponse, next: () => void): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}
