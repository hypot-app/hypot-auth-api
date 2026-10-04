import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { IsOriginAllowedUseCase } from '../application/is-origin-allowed.use-case';

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * CORS allowlist: a request's `Origin` is accepted when an active app registers exactly that
 * origin. CORS only tells the browser who may read a response, it is not authorization, so no
 * per-app context is needed and preflights (which carry no body) work. Unknown origins get no
 * CORS headers, so the browser blocks the response. Never answers with `*`.
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

      res.setHeader('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] ?? DEFAULT_ALLOWED_HEADERS,
        );
        res.setHeader('Access-Control-Max-Age', PREFLIGHT_MAX_AGE_SECONDS);
        res.statusCode = 204;
        res.end();
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  }
}
