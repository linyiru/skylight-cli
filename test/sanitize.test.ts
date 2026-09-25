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
