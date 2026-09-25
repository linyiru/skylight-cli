/**
 * Replays recorded fixtures through MSW, so tests exercise the real fetch path against real upstream
 * statuses, content types, and bodies.
 */
import { readFileSync } from 'node:fs';
import { http, HttpResponse, type HttpHandler } from 'msw';
import type { AuthKind, Recording } from './scenarios.ts';

/** Sanitized credentials, as written by test/support/sanitize.ts. */
export const FIXTURE_TOKENS: Partial<Record<AuthKind, string>> = {
  mcp: 'test-mcp-token', session: 'test-session-token', client: 'test-client-token',
};

export function fixture(name: string): Recording {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as Recording;
}

export function fixtureResponse(recording: Recording): Response {
  const { status, contentType, body } = recording.response;
  const text = body === null ? null : typeof body === 'string' ? body : JSON.stringify(body);
  return new HttpResponse(text, { status, headers: contentType ? { 'content-type': contentType } : {} });
}

/** Path without query: fixtures pin ids and names, while timestamps differ per run. */
const pathOf = (url: string) => {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
};

export interface Replay {
  /** Requests that reached this handler. */
  requests: Request[];
}

/**
 * A handler answering with the fixture. Requests must carry the credential kind the fixture was recorded
 * with (e.g. a client API token for data-service calls); anything else fails the test with a 599.
 */
export function replay(name: string, { once = false }: { once?: boolean } = {}): HttpHandler & Replay {
  const recording = fixture(name);
  const expected = FIXTURE_TOKENS[recording.request.auth];
  const requests: Request[] = [];
  const method = recording.request.method === 'POST' ? http.post : http.get;
  const handler = method(pathOf(recording.request.url), ({ request }) => {
    requests.push(request.clone());
    if (expected && request.headers.get('authorization') !== expected) {
      return new HttpResponse(`fixture ${name} expects the ${recording.request.auth} token`, { status: 599 });
    }
    return fixtureResponse(recording);
  }, { once });
  return Object.assign(handler, { requests });
}
