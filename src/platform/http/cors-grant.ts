import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A request that `AppCorsMiddleware` marked: its `Origin` belongs to an active app (ADR 38). */
export type CorsRequest = IncomingMessage & { corsCandidateOrigin?: string };

/** Lets the browser read this response. A no-op when the request has no candidate origin. */
export function grantCorsAllow(req: CorsRequest, res: ServerResponse): void {
  if (req.corsCandidateOrigin !== undefined) res.setHeader('Access-Control-Allow-Origin', req.corsCandidateOrigin);
}

/**
 * Injects `() => void` that grants `Access-Control-Allow-Origin` to the request's origin.
 * Fail-closed: an endpoint that never calls it, and any unexpected 500, emits no allow header.
 * Call it only once the origin is bound to the app (ADR 38), or for answers that carry no app
 * data (request validation, rate limits). Never after a binding rejection.
 */
export const CorsGrant = createParamDecorator((_data: unknown, context: ExecutionContext): (() => void) => {
  const http = context.switchToHttp();
  const req = http.getRequest<CorsRequest>();
  const res = http.getResponse<ServerResponse>();
  return () => grantCorsAllow(req, res);
});
