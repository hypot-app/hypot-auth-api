import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { IsOriginAllowedUseCase } from '../application/is-origin-allowed.use-case';

/** Removes the allow header so a browser cannot read a response to an origin not bound to the app. */
export function withdrawCorsAllow(res: ServerResponse): void {
  res.removeHeader('Access-Control-Allow-Origin');
}

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * CORS headers layer (ADR 29, 38): a request's `Origin` is accepted when ANY active app registers
 * exactly that origin, so preflights (which carry no body) work. The per-app binding of the actual
 * request is the application layer's job (`ResolveClientUseCase` with `origin`): an endpoint that
 * rejects the binding removes the allow header with `withdrawCorsAllow`. Unknown origins get no
 * CORS headers, so the browser blocks the response. Never answers with `*` or credentials.
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
        // Fixed list, never echoed from the request (ADR 38).
        res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
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
