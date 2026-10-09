import type { INestApplication } from '@nestjs/common';

export interface RegisteredRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD';
  path: string;
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/**
 * Every distinct route Express holds for a Nest application built by configureApp, sorted. Read from the router
 * itself, so a controller that is registered but missing from a document shows up here. Nest registers a route
 * middleware (CORS, no-store) as an extra layer with the same method, sometimes with a trailing slash, so layers
 * are normalized and de-duplicated by method and path.
 */
export function listRoutes(app: INestApplication): RegisteredRoute[] {
  const express = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
  const seen = new Map<string, RegisteredRoute>();
  for (const layer of express.router.stack) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (!enabled) continue;
      const path = layer.route.path.length > 1 ? layer.route.path.replace(/\/$/, '') : layer.route.path;
      const route = { method: method.toUpperCase() as RegisteredRoute['method'], path };
      seen.set(`${route.method} ${route.path}`, route);
    }
  }
  return [...seen.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}
