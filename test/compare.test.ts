import test from 'node:test';
import assert from 'node:assert/strict';
import { compareEndpoints } from '../src/compare.ts';
import { rankEndpoints } from '../src/rank.ts';
import type { EndpointHighlight } from '../src/types.ts';

const endpoint = (name: string, count: number, p50: number, p95 = p50 * 2): EndpointHighlight =>
  ({ name, count, latencyP50: p50, latencyP95: p95, latencyP99: p95, inspections: {} });

test('ranks changes by request time added per minute, and lists new and gone endpoints', () => {
  const before = rankEndpoints([endpoint('busy', 6_000, 20), endpoint('rare', 30, 100), endpoint('gone', 50, 10),
    endpoint('thin', 5, 10), endpoint('faster', 600, 50)], 600);
  const after = rankEndpoints([endpoint('busy', 6_000, 25), endpoint('rare', 30, 300), endpoint('new', 90, 10),
    endpoint('thin', 5, 900), endpoint('faster', 600, 40)], 600);
  const { changed, appeared, disappeared } = compareEndpoints(before, after);
  // busy: +5 ms × 600 rpm = 3000 ms/min beats rare: +200 ms × 3 rpm = 600 ms/min.
  assert.deepEqual(changed.map(c => [c.name, c.impactMsPerMinute]), [['busy', 3000], ['rare', 600], ['faster', -600]]);
  assert.equal(changed[0]!.p50Change, 0.25);
  // `thin` has too few requests to compare.
  assert.deepEqual(appeared.map(e => e.name), ['new']);
  assert.deepEqual(disappeared.map(e => e.name), ['gone']);
  assert.ok(compareEndpoints(before, after, { minRequests: 1 }).changed.some(c => c.name === 'thin'));
});
