import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireJson } from './require-json.middleware';

interface Outcome {
  next: jest.Mock;
  status: number | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

function run(method: string, url: string, contentType?: string): Outcome {
  const outcome: Outcome = { next: jest.fn(), status: undefined, headers: {}, body: undefined };
  const req = {
    method,
    url,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  } as unknown as IncomingMessage;
  const res = {
    set statusCode(value: number) {
      outcome.status = value;
    },
    setHeader: (name: string, value: string) => {
      outcome.headers[name] = value;
    },
    end: (body: string) => {
      outcome.body = body;
    },
  } as unknown as ServerResponse;
  requireJson(req, res, outcome.next);
  return outcome;
}

const BODY = { error: 'unsupported_media_type', message: 'Request body must be JSON.' };

describe('requireJson', () => {
  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON;charset=UTF-8',
    'APPLICATION/JSON ; charset=utf-8',
  ])('lets a POST with %s through', (contentType) => {
    const outcome = run('POST', '/api/v1/accounts/signup', contentType);

    expect(outcome.next).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBeUndefined();
  });

  it.each([
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
    'text/plain',
    'text/plain;charset=UTF-8',
    'application/jsonp',
    'application/json-patch+json',
    'application/vnd.api+json',
    'text/json',
    '',
  ])('answers 415 to a POST with %p', (contentType) => {
    const outcome = run('POST', '/api/v1/auth/login', contentType);

    expect(outcome.next).not.toHaveBeenCalled();
    expect(outcome.status).toBe(415);
    expect(outcome.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(outcome.body ?? '')).toEqual(BODY);
  });

  it('answers 415 to a POST with no Content-Type at all', () => {
    const outcome = run('POST', '/api/v1/auth/logout');

    expect(outcome.next).not.toHaveBeenCalled();
    expect(outcome.status).toBe(415);
  });

  it.each(['/api/v1/accounts/confirm?x=1', '/API/V1/accounts/confirm', '/api/v1', '/Api/V1/anything/new'])(
    'covers every POST under the prefix: %s',
    (url) => {
      expect(run('POST', url, 'text/plain').status).toBe(415);
    },
  );

  it.each([
    ['GET', '/api/v1/me'],
    ['OPTIONS', '/api/v1/auth/login'],
    ['HEAD', '/api/v1/me'],
    ['POST', '/health'],
    ['POST', '/'],
    ['POST', '/api/v10/x'],
    ['POST', '/.well-known/jwks.json'],
  ])('ignores %s %s', (method, url) => {
    const outcome = run(method, url, 'text/plain');

    expect(outcome.next).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBeUndefined();
  });

  it('does not grant CORS: it runs before any origin lookup', () => {
    const outcome = run('POST', '/api/v1/auth/login', 'text/plain');

    expect(Object.keys(outcome.headers).map((name) => name.toLowerCase())).not.toContain('access-control-allow-origin');
  });
});
