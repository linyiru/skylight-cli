import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceTree } from '../src/trace.ts';
import { diffTraceTrees } from '../src/trace-diff.ts';
import type { TraceNode, TraceSpan } from '../src/types.ts';

const span = (count: number, start: number, duration: number): TraceSpan => [0, count, 0, 0, start, duration, 0, []];
const tree = (nodes: TraceNode[]) => buildTraceTree({ targets: [{ start: 0, length: 10, requests: [] }], nodes })!;

// Before: 10 requests of 50 ms; a query in every one. After: 70 ms, the query is slower, a new call in half of them.
const before = tree([
  [null, 'app.controller.request', 'C#a', null, [span(10, 0, 50)]],
  [0, 'db.sql.query', 'SELECT FROM users', null, [span(10, 5, 10)]],
  [0, 'db.sql.query', 'SELECT FROM users', null, [span(10, 20, 5)]],
  [0, 'app.http', 'Old API', null, [span(10, 30, 4)]],
]);
const after = tree([
  [null, 'app.controller.request', 'C#a', null, [span(10, 0, 70)]],
  [0, 'db.sql.query', 'SELECT FROM users', null, [span(10, 5, 20)]],
  [0, 'db.sql.query', 'SELECT FROM users', null, [span(10, 30, 5)]],
  [0, 'app.http', 'New API', null, [span(5, 40, 20)]],
]);

test('event deltas add up to the change in the average request', () => {
  const diff = diffTraceTrees(before, after);
  assert.equal(diff.before, 50);
  assert.equal(diff.after, 70);
  const total = [...diff.changed, ...diff.appeared, ...diff.disappeared].reduce((sum, c) => sum + c.deltaMs, 0);
  assert.ok(Math.abs(total - 20) < 1e-9, String(total));
});

test('matches events by path, numbering same-named siblings by start time', () => {
  const diff = diffTraceTrees(before, after);
  const byPath = Object.fromEntries(diff.changed.map(c => [c.path.join(' > '), c]));
  assert.equal(byPath['C#a > SELECT FROM users']!.deltaMs, 10);
  assert.equal(byPath['C#a > SELECT FROM users #2']!.deltaMs, 0);
  // The new call runs in half the requests: 20 ms × 50% = 10 ms per average request.
  assert.deepEqual(diff.appeared.map(c => [c.path.at(-1), c.deltaMs]), [['New API', 10]]);
  assert.deepEqual(diff.disappeared.map(c => [c.path.at(-1), c.deltaMs]), [['Old API', -4]]);
  assert.equal(diff.changed[0]!.path.at(-1), 'SELECT FROM users');
});
