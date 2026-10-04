import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { ResolveClientUseCase } from '../application/resolve-client.use-case';

/** Express adds `query` and `body`; typed structurally so the app needs no express typings. */
interface CorsRequest extends IncomingMessage {
  query?: Record<string, unknown>;
  body?: unknown;
}

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type, Authorization';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

/**
 * CORS decided per app: the origin must be registered on the app named by the
 * request's `client_id` (query string or form body). Anything else gets no CORS
 * headers, so the browser blocks the response. Never answers with `*`.
 *
 * A browser preflight carries no body, so SPAs must put `client_id` in the URL
 * query string of requests that need CORS.
 */
@Injectable()
export class AppCorsMiddleware implements NestMiddleware {
  constructor(@Inject(ResolveClientUseCase) private readonly resolveClient: ResolveClientUseCase) {}

  async use(req: CorsRequest, res: ServerResponse, next: (error?: unknown) => void): Promise<void> {
    try {
      const origin = req.headers.origin;
      if (origin === undefined) return next();

      // The response depends on Origin, so caches must key on it.
      res.setHeader('Vary', 'Origin');

      const allowed = await this.isOriginAllowed(req, origin);
      if (!allowed) return next();

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

  private async isOriginAllowed(req: CorsRequest, origin: string): Promise<boolean> {
    const clientId = extractClientId(req);
    if (clientId === undefined) return false;
    const result = await this.resolveClient.execute({ clientId });
    return result.ok && result.value.allowsOrigin(origin);
  }
}

function extractClientId(req: CorsRequest): string | undefined {
  const fromQuery = req.query?.['client_id'];
  if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery;
  const body = req.body;
  if (typeof body === 'object' && body !== null) {
    const fromBody = (body as Record<string, unknown>)['client_id'];
    if (typeof fromBody === 'string' && fromBody !== '') return fromBody;
  }
  return undefined;
}
