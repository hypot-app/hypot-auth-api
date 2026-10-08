import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PREFIX } from '../../shared-kernel/api-prefix';

const UNSUPPORTED_BODY = JSON.stringify({ error: 'unsupported_media_type', message: 'Request body must be JSON.' });
/** Express matches routes case-insensitively, so the prefix test must too. */
const API_PATH = new RegExp(`^/${API_PREFIX}(?:[/?#]|$)`, 'i');
const JSON_TYPE = /^\s*application\/json\s*(?:;|$)/i;

/**
 * Answers `415` to any `POST` under the API prefix whose `Content-Type` is not `application/json`
 * (parameters such as `; charset=utf-8` are fine, the type is case-insensitive). A `POST` with no
 * `Content-Type` is refused too: every endpoint takes a JSON body, and an empty cross-site
 * `fetch(..., { mode: 'no-cors' })` is exactly that shape.
 *
 * Why: an HTML form (`urlencoded`, `multipart/form-data`, `text/plain`) and a `no-cors` fetch are
 * "simple" cross-site requests, sent with no preflight. Without this guard they would reach the
 * handlers and burn the per-IP budgets (`email_ip`, `confirm_ip`, ...) or force a bcrypt hash.
 *
 * It must run before the body parsers, the CORS middleware, the abuse guard and any lookup, so it is
 * registered in `configureApp` (before `app.init()`). It grants no CORS header: that would need a
 * database lookup of the origin, which is the work this guard exists to avoid. A legitimate browser
 * client always sends JSON, so it never sees this answer. Preflights (`OPTIONS`) and `GET` are unaffected.
 */
export function requireJson(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.method !== 'POST' || !API_PATH.test(req.url ?? '') || JSON_TYPE.test(req.headers['content-type'] ?? '')) {
    next();
    return;
  }
  res.statusCode = 415;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(UNSUPPORTED_BODY);
}
