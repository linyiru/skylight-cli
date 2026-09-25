/**
 * Client and CLI against recorded live responses (test/fixtures, see scripts/record-fixtures.ts).
 * Hand-built responses belong in skylight-client.test.ts; these tests only use what Skylight actually sent.
 */
import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { SkylightClient } from '../src/skylight-client.ts';
import { SkylightError } from '../src/errors.ts';
import { main } from '../src/cli.ts';
import { TREND_MAX_SECONDS_PER_REQUEST } from '../src/spec.ts';
import type { EndpointSummary, TrendSeries, WireAppsResponse } from '../src/types.ts';
import { FIXTURE_TOKENS, fixture, fixtureResponse, replay } from './support/msw.ts';

const server = setupServer();
before(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
after(() => server.close());

const client = () => new SkylightClient({ token: FIXTURE_TOKENS.mcp });
const componentGuid = (fixture('apps.ok').response.body as WireAppsResponse).apps[0]!.components[0]!.guid;
const dataBase = `https://data-v3.skylight.io/apps/${componentGuid}`;

/** Rejects with an HTTP_ERROR carrying the given status and nothing from the response body. */
async function rejectsWithStatus(promise: Promise<unknown>, status: number, body?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SkylightError);
    assert.equal(error.code, 'HTTP_ERROR');
    assert.equal(error.status, status);
    if (body) assert.doesNotMatch(inspect(error), new RegExp(body.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
}

async function cli(argv: string[]) {
  let stdout = '', stderr = '';
  const code = await main(argv, {
    env: { SKYLIGHT_MCP_TOKEN: FIXTURE_TOKENS.mcp },
    stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } },
  });
  return { code, stdout, stderr };
}

describe('happy path', () => {
  test('lists components without exposing credentials', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'));
    const components = await client().listComponents();
    assert.deepEqual(components.map(c => [c.guid, c.environment, c.name]), [[componentGuid, 'production', 'web']]);
    assert.doesNotMatch(JSON.stringify(components), /test-(session|client)-token|client_api_token/);
  });

  test('sends the three credential kinds where each belongs', async () => {
    const handlers = [replay('auth.ok'), replay('apps.ok'), replay('endpoint-highlights.ok'), replay('deploys.ok')];
    server.use(...handlers);
    const c = client();
    await c.listEndpoints();
    await c.listDeploys();
    // replay() answers 599 on a wrong credential, so reaching here means every call used the right one.
    assert.deepEqual(handlers.map(h => h.requests.length), [1, 1, 1, 1]);
  });

  test('endpoint highlights: search, sort, and limit apply to the real payload', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('endpoint-highlights.ok'));
    const result = await client().listEndpoints({ sortBy: 'count', limit: 3 });
    const counts = result.endpoints.map(e => e.count);
    assert.equal(result.endpoints.length, 3);
    assert.deepEqual(counts, counts.toSorted((a, b) => b - a));
    for (const e of result.endpoints) assert.equal(typeof e.latencyP95, 'number');
  });

  test('deploys: parses the application/vnd.api+json response', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('deploys.ok'));
    const result = await client().listDeploys({ limit: 2 });
    assert.equal(fixture('deploys.ok').response.contentType?.split(';')[0], 'application/vnd.api+json');
    assert.equal(result.data.length, 2);
    assert.match(result.data[0]!.attributes.git_sha, /^[0-9a-f]{40}$/);
  });

  test('trends: returns the bucketed series', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('trends.ok'));
    const series = await client().getLatencyTrends({ duration: 3 * 3_600, step: 3_600 });
    assert.equal(series.step, 3_600);
    assert.equal(series.counts.length, 3);
    assert.equal(series.latenciesP99.length, 3);
  });

  test('trends: windows over 7 days are split into requests upstream accepts, then concatenated', async () => {
    const [bucket] = [(fixture('trends.ok').response.body as { ranges: TrendSeries[] }).ranges[0]!];
    const bodies: { ranges: { timestamp: number; step: number; count: number }[] }[] = [];
    server.use(replay('auth.ok'), replay('apps.ok'), http.post(`${dataBase}/application_highlights`, async ({ request }) => {
      const body = await request.clone().json() as (typeof bodies)[number];
      bodies.push(body);
      // Answer with the recorded values, repeated to the requested length.
      const [range] = body.ranges;
      const fill = <T>(values: T[]) => Array.from({ length: range!.count }, (_, i) => values[i % values.length]!);
      return Response.json({ ranges: [{ ...bucket, timestamp: range!.timestamp, step: range!.step,
        duration: range!.step * range!.count, counts: fill(bucket.counts), latenciesP50: fill(bucket.latenciesP50),
        latenciesP90: fill(bucket.latenciesP90), latenciesP95: fill(bucket.latenciesP95),
        latenciesP98: fill(bucket.latenciesP98), latenciesP99: fill(bucket.latenciesP99), latenciesMax: fill(bucket.latenciesMax) }] });
    }));
    const series = await client().getLatencyTrends({ timestamp: 1_789_000_000, duration: 10 * 86_400, step: 3_600 });
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(body.ranges.reduce((sum, r) => sum + r.step * r.count, 0) <= TREND_MAX_SECONDS_PER_REQUEST);
    }
    assert.equal(series.counts.length, 240);
    assert.equal(series.timestamp, bodies.map(b => b.ranges[0]!.timestamp).sort()[0]);
  });

  test('endpoint summary: latency digest and N+1 inspection', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('summary.n-plus-one'));
    const name = (fixture('summary.n-plus-one').response.body as EndpointSummary).endpoint.name;
    const detail = await client().getEndpointDetail({ endpoint: name });
    const { latencies } = detail.endpoint;
    assert.equal(latencies.nodes.reduce((sum, [, , count]) => sum + count, 0), latencies.count);
    const [inspection] = detail.inspections.results;
    assert.equal(inspection?.type, 'nPlusOneQuery');
    assert.equal(inspection?.event[0], 'db.sql.query');
  });

  test('endpoint summary: an unknown endpoint is 200 with zero requests, not 404', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('summary.unknown-endpoint'));
    const detail = await client().getEndpointDetail({ endpoint: 'FixtureProbeController#missing' });
    assert.equal(detail.endpoint.count, 0);
    assert.deepEqual(detail.inspections.results, []);
  });
});

describe('recorded upstream errors', () => {
  test('invalid MCP token: 401 JSON error; body is not exposed', async () => {
    const recording = fixture('auth.invalid-token');
    assert.deepEqual(recording.response.body, { error: { status: 401, reason: 'unauthorized', message: 'Invalid or inactive MCP token.' } });
    server.use(replay('auth.invalid-token'));
    await rejectsWithStatus(new SkylightClient({ token: 'test-invalid' }).listApps(), 401, 'Invalid or inactive MCP token');
  });

  test('a Bearer prefix is rejected like a bad token, which is why the client sends the raw token', () => {
    assert.equal(fixture('auth.bearer-prefix').response.status, 401);
  });

  test('401 on apps refreshes the session once, then fails', async () => {
    const auth = replay('auth.ok');
    server.use(auth, replay('apps.invalid-token'));
    await rejectsWithStatus(client().listApps(), 401);
    assert.equal(auth.requests.length, 2);
  });

  test('data service 401 (empty body) refreshes the token chain once, then fails', async () => {
    const auth = replay('auth.ok');
    server.use(auth, replay('apps.ok'), replay('endpoint-highlights.invalid-token'));
    await rejectsWithStatus(client().listEndpoints(), 401);
    assert.equal(auth.requests.length, 2);
  });

  for (const [name, call, status] of [
    ['endpoint-highlights.unknown-component', (c: SkylightClient) => c.listEndpoints(), 404],
    ['deploys.unknown-component', (c: SkylightClient) => c.listDeploys(), 404],
    ['endpoint-highlights.over-24h', (c: SkylightClient) => c.listEndpoints(), 422],
    ['summary.unencoded-segment', (c: SkylightClient) => c.getEndpointDetail({ endpoint: 'AnyController#show' }), 404],
  ] as const) {
    test(`${name}: HTTP ${status} becomes HTTP_ERROR`, async () => {
      assert.equal(fixture(name).response.status, status);
      // Serve the recorded error on the route the client calls.
      const route = name.startsWith('deploys') ? http.get('https://www.skylight.io/deploys', () => fixtureResponse(fixture(name)))
        : http.post(`${dataBase}/*`, () => fixtureResponse(fixture(name)));
      server.use(replay('auth.ok'), replay('apps.ok'), route);
      await rejectsWithStatus(call(client()), status, String(fixture(name).response.body ?? ''));
    });
  }

  test('deploys: Accept application/json is 406 upstream; the client sends */*', async () => {
    assert.equal(fixture('deploys.accept-json').response.status, 406);
    const deploys = replay('deploys.ok');
    server.use(replay('auth.ok'), replay('apps.ok'), deploys);
    await client().listDeploys();
    assert.equal(deploys.requests[0]?.headers.get('accept'), '*/*');
  });

  test('limits the client enforces locally are real upstream errors', async () => {
    assert.match(String(fixture('trends.invalid-step').response.body), /InvalidRangeStep/);
    assert.equal(fixture('trends.over-7-days').response.status, 422);
    server.use(replay('auth.ok'), replay('apps.ok'));
    // Neither reaches the network: onUnhandledRequest would fail the test.
    await assert.rejects(client().getLatencyTrends({ step: 86_400 as never }), { code: 'INVALID_STEP' });
    await assert.rejects(client().listEndpoints({ duration: 108_000 }), { code: 'INVALID_DURATION' });
  });
});

describe('CLI on recorded responses', () => {
  test('trends prints one row per bucket', async () => {
    server.use(replay('auth.ok'), replay('apps.ok'), replay('trends.ok'));
    const { code, stdout } = await cli(['trends', '--since', '3h', '--step', '3600']);
    assert.equal(code, 0);
    assert.match(stdout, /^Window .* step 3600s; \d+ requests\nTIME \(UTC\) +COUNT +P50/);
    assert.equal(stdout.trim().split('\n').length, 2 + 3);
  });

  test('endpoint resolves a search term, then shows latency and the N+1 query', async () => {
    const name = (fixture('summary.n-plus-one').response.body as EndpointSummary).endpoint.name;
    const highlights = fixture('endpoint-highlights.ok').response.body as { endpoints: { name: string }[] };
    server.use(replay('auth.ok'), replay('apps.ok'),
      // Put the summarized endpoint into the (truncated) highlights fixture so the search can find it.
      http.post(`${dataBase}/endpoint_highlights`, () => Response.json({ ...highlights,
        endpoints: [{ ...highlights.endpoints[0], name }, ...highlights.endpoints.filter(e => e.name !== name)] })),
      replay('summary.n-plus-one'));
    const { code, stdout } = await cli(['endpoint', name]);
    assert.equal(code, 0);
    assert.match(stdout, /^Endpoint +graphql:/);
    assert.match(stdout, /N\+1 query +severity \d+ +db\.sql\.query +SELECT FROM /);
  });

  test('trace renders the recorded trace as a tree', async () => {
    const summary = fixture('summary.ok').response.body as EndpointSummary;
    const highlights = fixture('endpoint-highlights.ok').response.body as { endpoints: { name: string }[] };
    server.use(replay('auth.ok'), replay('apps.ok'),
      http.post(`${dataBase}/endpoint_highlights`, () => Response.json({ ...highlights,
        endpoints: [{ ...highlights.endpoints[0], name: summary.endpoint.name }] })),
      replay('summary.ok'));
    const { code, stdout } = await cli(['trace', summary.endpoint.name, '--full']);
    assert.equal(code, 0);
    const events = stdout.split('\n').filter(line => /^\s+[\d.]+\s+[\d.]+/.test(line));
    // The fixture keeps the first 12 nodes; every one of them is reachable from the root.
    assert.equal(events.length, summary.trace.nodes.length);
    assert.match(events[0]!, /app\.rack\.request$/);
    assert.match(events[1]!, /[├└]─ /);
  });

  test('an upstream 401 is exit code 1 with a token hint', async () => {
    server.use(replay('auth.invalid-token'));
    const { code, stderr } = await cli(['auth']);
    assert.equal(code, 1);
    assert.match(stderr, /HTTP 401.*check SKYLIGHT_MCP_TOKEN/);
  });
});
