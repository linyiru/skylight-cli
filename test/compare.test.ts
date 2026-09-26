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

test('error changes are per route, separating more errors from more traffic', () => {
  const route = (errors: number, ok: number) => [
    endpoint('Gate<sk-segment>json</sk-segment>', ok, 20), endpoint('Gate<sk-segment>error</sk-segment>', errors, 10)];
  // Traffic doubles and errors double: same rate, so no error change. Busy's rate goes 1% → 5%.
  const before = rankEndpoints([...route(10, 90), endpoint('Busy<sk-segment>json</sk-segment>', 990, 20),
    endpoint('Busy<sk-segment>error</sk-segment>', 10, 5)], 600);
  const after = rankEndpoints([...route(20, 180), endpoint('Busy<sk-segment>json</sk-segment>', 950, 20),
    endpoint('Busy<sk-segment>error</sk-segment>', 50, 5)], 600);
  const { moreErrors, fewerErrors } = compareEndpoints(before, after);
  assert.deepEqual(moreErrors.map(c => c.name), ['Busy']);
  assert.equal(moreErrors[0]!.before.errorRate, 0.01);
  assert.equal(moreErrors[0]!.after.errorRate, 0.05);
  // (5% - 1%) × 100 rpm = 4 errors per minute beyond the old rate.
  assert.equal(moreErrors[0]!.addedErrorsPerMinute.toFixed(2), '4.00');
  assert.deepEqual(fewerErrors, []);
});
