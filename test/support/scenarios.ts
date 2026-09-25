/**
 * Live API scenarios. Recorded (then sanitized) into test/fixtures by scripts/record-fixtures.ts, and replayed
 * against the live API by test/live.test.ts to detect upstream drift. Raw fetch on purpose: the point is to
 * capture exactly what Skylight returns, including error statuses and bodies.
 */

import { PROBE_ENDPOINT_PREFIX } from './sanitize.ts';

export const WEB_URL = 'https://www.skylight.io';

export type AuthKind = 'mcp' | 'session' | 'client' | 'invalid' | 'none';

export interface LiveContext {
  mcpToken: string;
  session: string;
  dataUrl: string;
  appGuid: string;
  componentGuid: string;
  clientToken: string;
  /** Busiest endpoint in the last 6h. */
  endpoint: string;
  /** An endpoint with an N+1 inspection in the last 6h, if any. */
  inspectedEndpoint: string | undefined;
  /** Busiest endpoint whose name carries a `<sk-segment>` tag, if any. */
  segmentEndpoint: string | undefined;
  /** Source digests and a deploy ref from the N+1 endpoint's first 40 trace nodes (the ones its fixture keeps). */
  sourceDigests: string[];
  deployRef: string | undefined;
  /** Minute-aligned start of the last 6h. */
  since6h: number;
}

export interface ScenarioRequest {
  method: 'GET' | 'POST';
  url: string;
  auth: AuthKind;
  accept?: string;
  /** Send `Bearer <token>` instead of the raw token. */
  bearer?: boolean;
  /** JSON-serialized unless already a string. */
  body?: unknown;
}

export interface Scenario {
  name: string;
  description: string;
  request(ctx: LiveContext): ScenarioRequest | undefined;
}

export interface Recording {
  scenario: string;
  description: string;
  request: { method: string; url: string; auth: AuthKind; bearer: boolean; accept: string; body: unknown };
  response: { status: number; contentType: string | null; body: unknown };
}

const INVALID_TOKEN = 'skylight-cli-fixture-invalid-token';
const hour = 3_600;
const hourAligned = () => Math.floor(Date.now() / 1000 / hour) * hour;

export const SCENARIOS: Scenario[] = [
  { name: 'auth.ok', description: 'MCP token exchanged for a session token and data_url',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/authenticate`, auth: 'mcp' }) },
  { name: 'auth.invalid-token', description: 'Unknown MCP token',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/authenticate`, auth: 'invalid' }) },
  { name: 'auth.missing-token', description: 'No Authorization header',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/authenticate`, auth: 'none' }) },
  { name: 'auth.bearer-prefix', description: 'MCP token sent with a Bearer prefix',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/authenticate`, auth: 'mcp', bearer: true }) },

  { name: 'apps.ok', description: 'Apps, components, and per-component client API tokens',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/apps`, auth: 'session' }) },
  { name: 'apps.mcp-token', description: 'MCP token used where a session token is required',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/apps`, auth: 'mcp' }) },
  { name: 'apps.invalid-token', description: 'Unknown session token',
    request: () => ({ method: 'GET', url: `${WEB_URL}/mcp/apps`, auth: 'invalid' }) },

  { name: 'endpoint-highlights.ok', description: 'Endpoint metrics for the last 6h',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoint_highlights`, auth: 'client',
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'endpoint-highlights.invalid-token', description: 'Unknown client API token',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoint_highlights`, auth: 'invalid',
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'endpoint-highlights.session-token', description: 'Session token used where a client API token is required',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoint_highlights`, auth: 'session',
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'endpoint-highlights.unknown-component', description: 'Valid client token, another component id',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/AAAAAAAAAAAA/endpoint_highlights`, auth: 'client',
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'endpoint-highlights.string-timestamp', description: 'Body field of the wrong type',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoint_highlights`, auth: 'client',
      body: { timestamp: 'recent', duration: 21_600 } }) },
  { name: 'endpoint-highlights.over-24h', description: 'Duration above the documented 24h maximum',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoint_highlights`, auth: 'client',
      body: { timestamp: ctx.since6h - 86_400, duration: 108_000 } }) },

  { name: 'deploys.ok', description: 'Deploys for the last 45 days',
    request: ctx => ({ method: 'GET', auth: 'session',
      url: `${WEB_URL}/deploys?timestamp=${ctx.since6h + 21_600 - 3_888_000}&duration=3888000&app_component_id=${ctx.componentGuid}` }) },
  { name: 'deploys.accept-json', description: 'Accept: application/json instead of */*',
    request: ctx => ({ method: 'GET', auth: 'session', accept: 'application/json',
      url: `${WEB_URL}/deploys?timestamp=${ctx.since6h}&duration=21600&app_component_id=${ctx.componentGuid}` }) },
  { name: 'deploys.invalid-token', description: 'Unknown session token',
    request: ctx => ({ method: 'GET', auth: 'invalid',
      url: `${WEB_URL}/deploys?timestamp=${ctx.since6h}&duration=21600&app_component_id=${ctx.componentGuid}` }) },
  { name: 'deploys.unknown-component', description: 'Component id that does not exist',
    request: ctx => ({ method: 'GET', auth: 'session',
      url: `${WEB_URL}/deploys?timestamp=${ctx.since6h}&duration=21600&app_component_id=AAAAAAAAAAAA` }) },

  { name: 'trends.ok', description: 'Three hourly buckets',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { ranges: [{ timestamp: hourAligned() - 3 * hour, step: hour, count: 3 }] } }) },
  { name: 'trends.two-ranges', description: 'Two ranges in one request (sum within 7 days)',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { ranges: [{ timestamp: hourAligned() - 2 * hour, step: 60, count: 2 }, { timestamp: hourAligned() - hour, step: 600, count: 2 }] } }) },
  { name: 'trends.invalid-step', description: 'step not in 60/600/3600',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { ranges: [{ timestamp: hourAligned() - 86_400, step: 86_400, count: 1 }] } }) },
  { name: 'trends.over-7-days', description: 'step × count sums to more than 7 days',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { ranges: [{ timestamp: hourAligned() - 169 * hour, step: hour, count: 169 }] } }) },
  { name: 'trends.missing-ranges', description: 'Endpoint-style body instead of ranges',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'trends.missing-count', description: 'Range without count',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/application_highlights`, auth: 'client',
      body: { ranges: [{ timestamp: hourAligned() - hour, step: hour }] } }) },

  { name: 'source-locations.ok', description: 'Source locations by `{component}:{digest}` ids',
    request: ctx => ctx.sourceDigests.length === 0 ? undefined : ({ method: 'GET', auth: 'session',
      // Encoded like the client: digests may contain `+`, which unencoded would read as a space.
      url: `${WEB_URL}/source_locations?${new URLSearchParams({ 'filter[id]': ctx.sourceDigests.map(d => `${ctx.componentGuid}:${d}`).join(',') })}` }) },
  { name: 'source-locations.bare-digest', description: 'Digest without the component prefix matches nothing',
    request: ctx => ctx.sourceDigests.length === 0 ? undefined : ({ method: 'GET', auth: 'session',
      url: `${WEB_URL}/source_locations?${new URLSearchParams({ 'filter[id]': ctx.sourceDigests[0]! })}` }) },
  { name: 'source-locations.missing-filter', description: 'No filter[id]',
    request: () => ({ method: 'GET', auth: 'session', url: `${WEB_URL}/source_locations` }) },
  { name: 'source-locations.client-token', description: 'Client API token where a session token is required',
    request: ctx => ({ method: 'GET', auth: 'client', url: `${WEB_URL}/source_locations?filter[id]=${ctx.componentGuid}:AAAAA` }) },
  { name: 'deploy.ok', description: 'One deploy by the id a trace annotation refers to',
    request: ctx => ctx.deployRef === undefined ? undefined : ({ method: 'GET', auth: 'session', url: `${WEB_URL}/deploys/${ctx.deployRef}` }) },
  { name: 'deploy.unknown', description: 'Deploy id that does not exist',
    request: () => ({ method: 'GET', auth: 'session', url: `${WEB_URL}/deploys/AAAAAAAAAAAA` }) },

  { name: 'summary.ok', description: 'Busiest endpoint: latency digest, inspections, trace',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoints/${encodeURIComponent(ctx.endpoint)}/summary`,
      auth: 'client', body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'summary.n-plus-one', description: 'Endpoint with an N+1 inspection',
    request: ctx => ctx.inspectedEndpoint === undefined ? undefined : ({ method: 'POST', auth: 'client',
      url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoints/${encodeURIComponent(ctx.inspectedEndpoint)}/summary`,
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'summary.unknown-endpoint', description: 'Endpoint name that does not exist',
    request: ctx => ({ method: 'POST', url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoints/${encodeURIComponent(`${PROBE_ENDPOINT_PREFIX}Controller#missing`)}/summary`,
      auth: 'client', body: { timestamp: ctx.since6h, duration: 21_600 } }) },
  { name: 'summary.unencoded-segment', description: 'Endpoint name with the <sk-segment> tag not percent-encoded',
    request: ctx => ctx.segmentEndpoint === undefined ? undefined : ({ method: 'POST', auth: 'client',
      url: `${ctx.dataUrl}/apps/${ctx.componentGuid}/endpoints/${ctx.segmentEndpoint.replace('#', '%23')}/summary`,
      body: { timestamp: ctx.since6h, duration: 21_600 } }) },
];

function authorization(ctx: LiveContext, kind: AuthKind): string | undefined {
  return { mcp: ctx.mcpToken, session: ctx.session, client: ctx.clientToken, invalid: INVALID_TOKEN, none: undefined }[kind];
}

async function send(request: ScenarioRequest, ctx: LiveContext | { mcpToken: string }) {
  const token = authorization(ctx as LiveContext, request.auth);
  const accept = request.accept ?? '*/*';
  const body = request.body === undefined ? undefined
    : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  const response = await fetch(request.url, {
    method: request.method, redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: {
      accept, ...(token ? { authorization: request.bearer ? `Bearer ${token}` : token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body }),
  });
  const contentType = response.headers.get('content-type');
  const text = await response.text();
  let parsed: unknown = text;
  if (contentType?.includes('json')) { try { parsed = JSON.parse(text); } catch { /* keep text */ } }
  return { status: response.status, contentType, body: text === '' ? null : parsed, accept };
}

export async function runScenario(scenario: Scenario, ctx: LiveContext): Promise<Recording | undefined> {
  const request = scenario.request(ctx);
  if (!request) return undefined;
  const { accept, ...response } = await send(request, ctx);
  return {
    scenario: scenario.name, description: scenario.description,
    request: { method: request.method, url: request.url, auth: request.auth, bearer: request.bearer ?? false, accept,
      body: request.body ?? null },
    response,
  };
}

/** Walks the happy path with raw requests to learn tokens, ids, and interesting endpoints. */
export async function discover(mcpToken: string): Promise<LiveContext> {
  const base = { mcpToken } as LiveContext;
  const auth = await send({ method: 'GET', url: `${WEB_URL}/mcp/authenticate`, auth: 'mcp' }, base);
  const session = (auth.body as { session?: { token?: string } })?.session?.token;
  const dataUrl = String((auth.body as { data_url?: string })?.data_url ?? '').replace(/\/$/, '');
  if (auth.status !== 200 || !session || !dataUrl) throw new Error(`authenticate failed (HTTP ${auth.status})`);
  const apps = await send({ method: 'GET', url: `${WEB_URL}/mcp/apps`, auth: 'session' }, { ...base, session } as LiveContext);
  type Apps = { apps: { guid: string; components: { guid: string; name: string; client_api_token: { token: string } }[] }[] };
  const app = (apps.body as Apps).apps[0];
  const component = app?.components.find(c => c.name === 'web') ?? app?.components[0];
  if (!app || !component) throw new Error('no components visible to this token');
  const since6h = Math.floor(Date.now() / 60_000) * 60 - 21_600;
  const ctx: LiveContext = { mcpToken, session, dataUrl, appGuid: app.guid, componentGuid: component.guid,
    clientToken: component.client_api_token.token, endpoint: '', inspectedEndpoint: undefined, segmentEndpoint: undefined,
    sourceDigests: [], deployRef: undefined, since6h };
  const highlights = await send({ method: 'POST', url: `${dataUrl}/apps/${component.guid}/endpoint_highlights`, auth: 'client',
    body: { timestamp: since6h, duration: 21_600 } }, ctx);
  type Highlights = { endpoints: { name: string; count: number; inspections?: { nPlusOneQuery?: number } }[] };
  const endpoints = (highlights.body as Highlights).endpoints.toSorted((a, b) => b.count - a.count);
  if (!endpoints[0]) throw new Error('no endpoint traffic in the last 6h');
  ctx.endpoint = endpoints[0].name;
  ctx.inspectedEndpoint = endpoints.find(e => (e.inspections?.nPlusOneQuery ?? 0) > 0)?.name;
  ctx.segmentEndpoint = endpoints.find(e => e.name.includes('<sk-segment>'))?.name;
  // The N+1 endpoint runs app code (queries), so its trace carries app source locations with lines.
  const traced = ctx.inspectedEndpoint ?? ctx.endpoint;
  const summary = await send({ method: 'POST', url: `${dataUrl}/apps/${component.guid}/endpoints/${encodeURIComponent(traced)}/summary`,
    auth: 'client', body: { timestamp: since6h, duration: 21_600 } }, ctx);
  type Annotation = [number, ...unknown[]];
  const nodes = (summary.body as { trace?: { nodes?: [unknown, unknown, unknown, unknown, [...unknown[], Annotation[]][]][] } }).trace?.nodes ?? [];
  const digests = new Set<string>();
  for (const [, , , , spans] of nodes.slice(0, 40)) for (const span of spans) for (const annotation of span.at(-1) as Annotation[]) {
    if (annotation[0] !== 2) continue;
    for (const [ref, source] of annotation[1] as [string, string | null][]) {
      ctx.deployRef ??= ref;
      if (source) digests.add(source.split(':')[0]!);
    }
  }
  ctx.sourceDigests = [...digests];
  return ctx;
}
