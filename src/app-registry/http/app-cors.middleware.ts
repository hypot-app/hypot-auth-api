import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { IsOriginAllowedUseCase } from '../application/is-origin-allowed.use-case';
import type { CorsRequest } from './cors-grant';

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * CORS headers layer (ADR 29, 38), fail-closed. A preflight is answered here for any active app's
 * origin (it carries no body). On an actual request this only sets `Vary: Origin` and stashes the
 * candidate origin (an active app's origin) on the request: `Access-Control-Allow-Origin` itself is
 * granted later by `CorsGrant`, and only by code that decided the browser may read the response.
 * Never answers with `*` or credentials.
 */
@Injectable()
export class AppCorsMiddleware implements NestMiddleware {
  constructor(@Inject(IsOriginAllowedUseCase) private readonly isOriginAllowed: IsOriginAllowedUseCase) {}

  async use(req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): Promise<void> {
    try {
      const origin = req.headers.origin;
      if (origin === undefined) return next();

      // The response depends on Origin, so caches must key on it.
      res.setHeader('Vary', 'Origin');

      if (!(await this.isOriginAllowed.execute(origin))) return next();

      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        // Fixed list, never echoed from the request (ADR 38).
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
        res.statusCode = 204;
        res.end();
        return;
      }
      (req as CorsRequest).corsCandidateOrigin = origin;
      next();
    } catch (error) {
      next(error);
    }
  }
}
