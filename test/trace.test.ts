import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTraceTree, condenseTraceTree, countTraceNodes, locateTraceTree, needsInstrumentation, parseTraceSource,
  timeBreakdown, traceSourceRefs,
} from '../src/trace.ts';
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

test('parses trace source values: digest:line is app code, a bare digest is a gem', () => {
  assert.deepEqual(parseTraceSource(['deploy', 'abc12:76']), { deployRef: 'deploy', digest: 'abc12', line: 76 });
  assert.deepEqual(parseTraceSource(['deploy', 'gem01']), { deployRef: 'deploy', digest: 'gem01', line: null });
  assert.equal(parseTraceSource(['deploy', null]), undefined);
});

test('locates nodes: app code first, synthetic events dropped, unknown digests kept without a name', () => {
  const withSources = (sources: [string, string | null][]): TraceSpan => [0, 1, 0, 0, 0, 10, 0, [[1, 1, 0, 0], [2, sources]]];
  const tree = buildTraceTree({ targets: [{ start: 0, length: 10, requests: [] }], nodes: [
    [null, 'app.rack.request', null, null, [withSources([['d1', 'syn00']])]],
    [0, 'db.sql.query', 'SELECT FROM users', null, [withSources([['d1', 'gem01'], ['d1', 'app01:12'], ['d1', 'miss0:3']])]],
  ] })!;
  assert.deepEqual(traceSourceRefs(tree), { digests: ['syn00', 'gem01', 'app01', 'miss0'], deployRefs: ['d1'] });
  const located = locateTraceTree(tree, new Map([['syn00', '<synthetic>'], ['gem01', 'activerecord'], ['app01', 'app/models/user.rb']]),
    new Map([['d1', 'abcdef1234']]));
  assert.deepEqual(located.locations, []);
  const linked = locateTraceTree(tree, new Map([['app01', 'app/models/user.rb'], ['gem01', 'activerecord']]),
    new Map([['d1', 'abcdef1234']]), 'o/r').children[0]!.locations;
  assert.deepEqual(linked.map(l => l.url), ['https://github.com/o/r/tree/abcdef1234/app/models/user.rb#L12', null, null]);
  assert.deepEqual(located.children[0]!.locations.map(l => [l.name, l.line, l.inApp, l.gitSha]), [
    ['app/models/user.rb', 12, true, 'abcdef1234'], [null, 3, true, 'abcdef1234'], ['activerecord', null, false, 'abcdef1234']]);
});

test('self time subtracts a child only for the share of requests that run it', () => {
  // 4 requests of 100 ms; a 40 ms query runs in 1 of them. Per request the parent spends 100 - 40/4 = 90 ms itself.
  const tree = buildTraceTree({ targets: [{ start: 100, length: 10, requests: [] }], nodes: [
    [null, 'app.controller.request', 'C#a', null, [span(0, 4, 0, 100)]],
    [0, 'db.sql.query', 'SELECT', null, [span(0, 1, 10, 40)]],
  ] })!;
  assert.equal(tree.selfMs, 90);
  assert.equal(tree.children[0]!.occurrence, 0.25);
});

test('time breakdown sums self time by category group, weighted by requests', () => {
  const tree = buildTraceTree({ targets: [{ start: 100, length: 10, requests: [] }], nodes: [
    [null, 'app.rack.request', null, null, [span(0, 4, 0, 100)]],
    [0, 'rack.middleware', 'Rack::Cors', null, [span(0, 4, 0, 100)]],
    [1, 'app.controller.request', 'C#a', null, [span(0, 4, 0, 90)]],
    [2, 'db.sql.query', 'SELECT', null, [span(0, 4, 10, 40)]],
    [2, 'view.render.template', 'show', null, [span(0, 2, 60, 20)]],
  ] })!;
  // Self per request: rack 10, controller 90 - 40 - 20/2 = 40, db 40, view 20 × 2/4 = 10.
  assert.deepEqual(timeBreakdown(tree), { app: 40, db: 40, view: 10, other: 10 });
});

test('repetitions are averaged and the maximum kept; slow app code is flagged for instrumentation', () => {
  const repeated = (count: number, reps: number, max: number): TraceSpan => [0, count, reps, max, 0, 50, 0, []];
  const tree = buildTraceTree({ targets: [{ start: 50, length: 10, requests: [] }], nodes: [
    [null, 'app.controller.request', 'C#a', null, [repeated(2, 0, 0)]],
    [0, 'db.sql.query', 'SELECT', null, [repeated(2, 3, 7)]],
  ] })!;
  assert.equal(tree.children[0]!.repetitions, 3);
  assert.equal(tree.children[0]!.maxRepetitions, 7);
  // The controller's own code is 0 ms here, so nothing to instrument; a root doing everything itself is flagged.
  assert.deepEqual(needsInstrumentation(tree), []);
  assert.equal(needsInstrumentation(buildTraceTree({ targets: tree ? [{ start: 50, length: 10, requests: [] }] : [],
    nodes: [[null, 'app.controller.request', 'C#a', null, [repeated(2, 0, 0)]]] })!).length, 1);
});
