import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceTree, condenseTraceTree, countTraceNodes } from '../src/trace.ts';
import type { TraceNode, TraceSpan, TraceTarget } from '../src/types.ts';

// span: [target, samples, ?, ?, start relative to parent, duration, ?, [[1, samples, allocOffset, allocations], [2, sources]]]
const span = (target: number, samples: number, start: number, duration: number, allocations = 0): TraceSpan =>
  [target, samples, 0, 0, start, duration, 0, [[1, samples, 0, allocations], [2, [['deploy', `src-${target}`]]]]];

const targets: TraceTarget[] = [{ start: 20, length: 10, requests: [] }, { start: 200, length: 10, requests: [] }];
// root → middleware (pass-through) → controller → { sql (both buckets), slow call (slow bucket only) }
const nodes: TraceNode[] = [
  [null, 'app.rack.request', null, null, [span(0, 3, 0, 25, 100), span(1, 1, 0, 205, 300)]],
  [0, 'rack.middleware', 'Rack::Cors', null, [span(0, 3, 0.1, 24.3), span(1, 1, 0.1, 204.3)]],
  [1, 'app.controller.request', 'UsersController#index', null, [span(0, 3, 0.1, 24), span(1, 1, 0.1, 204)]],
  [2, 'app.http', 'Slow API', null, [span(1, 1, 20, 150)]],
  [2, 'db.sql.query', 'SELECT FROM users', 'SELECT "users".* FROM "users"', [span(0, 3, 2, 4), span(1, 1, 2, 8)]],
];

test('aggregates buckets into one tree with absolute starts, request-weighted means, and exact self time', () => {
  const root = buildTraceTree({ nodes, targets })!;
  assert.equal(root.samples, 4);
  assert.equal(root.durationMs, (25 * 3 + 205) / 4);
  const controller = root.children[0]!.children[0]!;
  assert.equal(controller.title, 'UsersController#index');
  // Children are ordered by start time, not upstream order.
  assert.deepEqual(controller.children.map(c => c.title), ['SELECT FROM users', 'Slow API']);
  const [sql, slow] = controller.children;
  assert.equal(sql!.occurrence, 1);
  assert.equal(slow!.occurrence, 0.25);
  assert.equal(slow!.durationMs, 150);
  // Absolute start: 0 + 0.1 + 0.1 + 20.
  assert.ok(Math.abs(slow!.startMs - 20.2) < 1e-9);
  // Self time per bucket: fast (24 - 4) × 3, slow (204 - 150 - 8) × 1.
  assert.equal(controller.selfMs, (20 * 3 + 46) / 4);
  assert.equal(root.allocations, (100 * 3 + 300) / 4);
  assert.deepEqual(slow!.sources, [['deploy', 'src-1']]);
});

test('filters by latency bucket', () => {
  const slowOnly = buildTraceTree({ nodes, targets }, { targets: t => t.start >= 200 })!;
  assert.equal(slowOnly.samples, 1);
  assert.equal(slowOnly.durationMs, 205);
  const fastOnly = buildTraceTree({ nodes, targets }, { targets: t => t.start < 200 })!;
  // The slow call never happens in fast requests, so it disappears.
  assert.deepEqual(fastOnly.children[0]!.children[0]!.children.map(c => c.title), ['SELECT FROM users']);
});

test('condensing folds pass-through middleware and drops rare or short events', () => {
  const root = buildTraceTree({ nodes, targets })!;
  assert.equal(countTraceNodes(root), 5);
  const condensed = condenseTraceTree(root);
  assert.equal(condensed.children[0]!.title, 'UsersController#index');
  assert.equal(countTraceNodes(condenseTraceTree(root, { minOccurrence: 0.5 })), 3);
  assert.equal(countTraceNodes(condenseTraceTree(root, { minDurationMs: 6 })), 3);
});

test('an empty trace, as for an endpoint without requests, has no tree', () => {
  assert.equal(buildTraceTree({ nodes: [], targets: [] }), undefined);
});
