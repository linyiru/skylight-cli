import test from 'node:test';
import assert from 'node:assert/strict';
import { Sanitizer } from './support/sanitize.ts';
import type { LiveContext, Recording } from './support/scenarios.ts';

const ctx = { mcpToken: 'real-mcp-token', session: 'real-session', clientToken: 'real-client' } as LiveContext;

function sanitize(body: unknown, key = 'a'.repeat(64)) {
  const sanitizer = new Sanitizer(Buffer.from(key, 'hex'), ctx);
  const recording: Recording = { scenario: 's', description: '', request: { method: 'POST', auth: 'client', bearer: false,
    accept: '*/*', url: 'https://data-v3.skylight.io/apps/RealGuid0001/endpoint_highlights', body: null },
  response: { status: 200, contentType: 'application/json', body } };
  const out = sanitizer.recording(recording);
  return { out, body: out.response.body as any, leaks: sanitizer.leaks(JSON.stringify(out)) };
}

const digest = { count: 1_000, min: 5, max: 993, nodes: [[0, 10, 100], [16, 0, 300], [17, 0, 400], [32, 5, 200]] };

test('renames every identifier in endpoint names, including actions, and keeps the structure', () => {
  const { body, leaks } = sanitize({ endpoints: [{ name: 'Admin::UsersController#destroy<sk-segment>json</sk-segment>' }] });
  assert.match(body.endpoints[0].name, /^Res[0-9a-f]{5}::Res[0-9a-f]{5}Controller#res[0-9a-f]{5}<sk-segment>json<\/sk-segment>$/);
  assert.deepEqual(leaks, []);
});

test('scales counts and latencies down, keeping zero and non-zero apart', () => {
  const { body } = sanitize({ endpoints: [{ name: 'A#b', count: 10_000, latencyP50: 100, latencyP95: 1_000, latencyP99: 0 }],
    ranges: [{ counts: [0, 1, 50_000], latenciesP95: [null, 40, 4_000] }] });
  const [e] = body.endpoints;
  assert.ok(e.count >= 500 && e.count <= 2_500);
  assert.ok(e.latencyP95 >= 350 && e.latencyP95 <= 700);
  assert.equal(e.latencyP99, 0);
  assert.deepEqual(body.ranges[0].counts.slice(0, 2), [0, 1]);
  assert.equal(body.ranges[0].latenciesP95[0], null);
});

test('scaled q-digests stay valid: aligned nodes whose counts sum to count', () => {
  const { body } = sanitize({ endpoint: { latencies: digest }, inspections: { results: [{ repetitions: digest }] } });
  for (const d of [body.endpoint.latencies, body.inspections.results[0].repetitions]) {
    assert.equal(d.nodes.reduce((sum: number, [, , c]: [number, number, number]) => sum + c, 0), d.count);
    for (const [lower, level] of d.nodes) assert.equal(lower % 2 ** level, 0);
    assert.ok(d.count < digest.count);
  }
  assert.ok(body.endpoint.latencies.max < digest.max);
  // Repetitions are queries per request, not time: values unchanged.
  assert.equal(body.inspections.results[0].repetitions.max, digest.max);
});

test('zeroes numbers inside trace tuples but keeps the trace window', () => {
  const { body } = sanitize({ trace: { count: 5_000, timestamp: 1_790_000_000, duration: 21_600, nodes: [[3, 'x', [[12, 34]]]] } });
  assert.equal(body.trace.timestamp, 1_790_000_000);
  assert.equal(body.trace.duration, 21_600);
  assert.deepEqual(body.trace.nodes[0][0], 0);
  assert.deepEqual(body.trace.nodes[0][2], [[0, 0]]);
});

test('scale factors depend on the key', () => {
  const count = (key: string) => sanitize({ endpoints: [{ name: 'A#b', count: 1_000_000 }] }, key).body.endpoints[0].count;
  assert.notEqual(count('a'.repeat(64)), count('b'.repeat(64)));
});

test('source digests map the same way in traces, ids, and URLs; paths keep only their shape', () => {
  const sanitizer = new Sanitizer(Buffer.from('c'.repeat(64), 'hex'), ctx);
  const recording = (url: string, body: unknown): Recording => ({ scenario: 's', description: '', request: { method: 'GET',
    auth: 'session', bearer: false, accept: '*/*', url, body: null }, response: { status: 200, contentType: 'application/json', body } });
  const trace = sanitizer.recording(recording('https://data-v3.skylight.io/apps/RealGuid0001/endpoints/A%23b/summary',
    { trace: { nodes: [[null, 'x', null, null, [[0, 1, 0, 0, 0, 1, 0, [[1, 1, 5, 9], [2, [['RealDeploy01', 'dig01:76']]]]]]]] } }));
  const lookup = sanitizer.recording(recording('https://www.skylight.io/source_locations?filter[id]=RealGuid0001:dig01',
    { data: [{ id: 'RealGuid0001:dig01', attributes: { name: 'app/finders/school_finder.rb', digest: 'dig01', collector_id: 'RealGuid0001' } }] }));
  const [kind, [[deployRef, source]]] = (trace.response.body as any).trace.nodes[0][4][0][7][1];
  const record = (lookup.response.body as any).data[0];
  assert.equal(kind, 2);
  assert.equal(source.split(':')[1], '76');
  assert.equal(source.split(':')[0], record.attributes.digest);
  assert.equal(record.id, `${record.attributes.collector_id}:${record.attributes.digest}`);
  assert.equal(new URL(lookup.request.url).searchParams.get('filter[id]'), record.id);
  assert.match(record.attributes.name, /^app\/res[0-9a-f]{5}\/res[0-9a-f]{5}\.rb$/);
  assert.match(deployRef, /^fx[0-9a-f]{10}$/);
  // Request count scaled (at least 1), allocations zeroed.
  assert.deepEqual((trace.response.body as any).trace.nodes[0][4][0][7][0], [1, 1, 0, 0]);
  assert.deepEqual(sanitizer.leaks(JSON.stringify([trace, lookup])), []);
});
