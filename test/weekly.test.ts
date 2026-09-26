import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateEndpointDays, weekStart, weeklyReport, WEEK_SECONDS, type WeekData, type WeekStats } from '../src/weekly.ts';
import type { EndpointHighlight } from '../src/types.ts';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

test('weeks start Monday 00:00 UTC, as Skylight Trends and data retention do', () => {
  assert.equal(weekStart(day('2026-09-25') + 3_600), day('2026-09-21')); // Friday
  assert.equal(weekStart(day('2026-09-21')), day('2026-09-21')); // Monday
  assert.equal(weekStart(day('2026-09-20') + 86_399), day('2026-09-14')); // Sunday night
});

test('daily endpoint stats combine into request-weighted weekly means', () => {
  const e = (count: number, p50: number, p95: number): EndpointHighlight =>
    ({ name: 'A#b', count, latencyP50: p50, latencyP95: p95, latencyP99: p95, inspections: {} });
  const week = aggregateEndpointDays([[e(100, 10, 50)], [e(300, 20, 90)], [e(0, 999, 999)]]);
  assert.deepEqual(week.get('A#b'), { count: 400, p50: 17.5, p95: 80 });
});

const stats = (count: number, p50: number, p95: number): WeekStats => ({ count, p50, p95 });
const week = (index: number, endpoints: Record<string, WeekStats>, app: WeekStats | null = stats(10_000, 10, 50)): WeekData =>
  ({ start: index * WEEK_SECONDS, end: (index + 1) * WEEK_SECONDS, app, endpoints: new Map(Object.entries(endpoints)) });

test('reports the week against the one before, and frog boils across all weeks', () => {
  const weeks = [0, 1, 2, 3, 4, 5].map(i => week(i, {
    creep: stats(1_000, 20, 100 + i * 15), // +75% over six weeks, never jumping
    jump: stats(1_000, 20, i === 5 ? 200 : 100),
    better: stats(1_000, 20, i === 5 ? 40 : 100),
    rare: stats(10, 20, i === 5 ? 900 : 100),
  }, i === 5 ? stats(12_000, 12, 50) : stats(10_000, 10, 50)));
  const report = weeklyReport(weeks);
  const [typical, problem] = report.reports;
  assert.equal(report.requests.after, 12_000);
  assert.equal(typical.change?.toFixed(2), '0.20');
  assert.ok(typical.changed);
  assert.ok(!problem.changed);
  // creep's last step (160 → 175) is under 10%: a boil, not a slowdown; rare has too few requests.
  assert.deepEqual(problem.slowdowns.map(c => c.name), ['jump']);
  assert.deepEqual(problem.improved.map(c => c.name), ['better']);
  assert.deepEqual(problem.boils.map(b => b.name), ['creep']);
  assert.deepEqual(problem.boils[0]!.series, [100, 115, 130, 145, 160, 175]);
  assert.equal(report.boilWeeks, 6);
});

test('frog boils need data in every week', () => {
  const weeks = [0, 1, 2].map(i => week(i, i === 1 ? {} : { creep: stats(1_000, 20, 100 + i * 50) }));
  assert.equal(weeklyReport(weeks).boilWeeks, 0);
  assert.deepEqual(weeklyReport(weeks).reports[1].boils, []);
});
