import test from 'node:test';
import assert from 'node:assert/strict';
import { gradeFor, rankEndpoints } from '../src/rank.ts';
import { digestHistogram, digestQuantile } from '../src/digest.ts';
import type { EndpointHighlight, QDigest } from '../src/types.ts';

const endpoint = (name: string, count: number, p50: number, p95: number, allocations = 0): EndpointHighlight =>
  ({ name, count, latencyP50: p50, latencyP95: p95, latencyP99: p95, inspections: { objectAllocations: allocations } });

test('grades by p50 with inclusive bounds, as checked against the UI (38 ms is B, 51 is B-, 58 is C+)', () => {
  assert.deepEqual([3, 4, 38, 39, 51, 58, 709, 710].map(gradeFor), ['A+', 'A', 'B', 'B-', 'B-', 'C+', 'D', 'F']);
});

test('agony is the minimum of the rpm, p50, and p95 ranks; popularity is log-scaled rpm', () => {
  const ranked = rankEndpoints([
    endpoint('busy-slow', 6000, 300, 900), endpoint('busy-fast', 6000, 5, 10), endpoint('rare-slow', 6, 300, 900),
    endpoint('mid', 600, 50, 100), endpoint('mid2', 300, 40, 90), endpoint('idle', 0, 1, 1),
  ], 600);
  const by = Object.fromEntries(ranked.map(e => [e.name, e]));
  assert.equal(by['busy-slow']!.rpm, 600);
  assert.equal(by['busy-slow']!.agony, 2);
  assert.equal(by['busy-fast']!.agony, 0);
  assert.equal(by['rare-slow']!.agony, 0);
  assert.equal(by['busy-slow']!.popularity, 10);
  assert.ok(by['rare-slow']!.popularity < by['mid']!.popularity);
  assert.equal(by['idle']!.agony, 0);
  assert.equal(by['idle']!.popularity, 0);
});

test('high allocations: top 5% by total and over 10,000 objects per request', () => {
  // Over 600 s: 40 endpoints at 100 rpm × 100 objects (total 10,000), one heavy at 100 rpm × 50,000, and one with
  // as many objects per request but 0.1 rpm (total 5,000), below the 95th-percentile total.
  const many = Array.from({ length: 40 }, (_, i) => endpoint(`e${i}`, 1_000, 10, 20, 100));
  const ranked = rankEndpoints([...many, endpoint('heavy', 1_000, 10, 20, 50_000), endpoint('rare-heavy', 1, 10, 20, 50_000)], 600);
  assert.deepEqual(ranked.filter(e => e.highAllocations).map(e => e.name), ['heavy']);
});

const digest: QDigest = { count: 1_000, min: 5, max: 993, nodes: [[0, 10, 100], [16, 0, 300], [17, 0, 400], [32, 5, 200]] };

test('digest quantiles and histograms preserve the total count', () => {
  assert.equal(digestQuantile(digest, 0.5), 17);
  assert.equal(digestQuantile({ ...digest, nodes: [] }, 0.5), undefined);
  const buckets = digestHistogram(digest, { from: 0, to: 1024, buckets: 8 });
  assert.equal(Math.round(buckets.reduce((sum, b) => sum + b.count, 0)), 1_000);
  assert.throws(() => digestQuantile(digest, 2), RangeError);
});
