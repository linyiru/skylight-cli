/**
 * A weekly report like Skylight's Trends (typical and problem performance vs last week, biggest slowdowns, most
 * improved, and frog boils over 6 weeks), rebuilt from endpoint and app highlights. Skylight's own report is not
 * readable with an MCP token, and its selection rules run server-side, so the thresholds here are ours.
 */
import type { EndpointHighlight, TrendSeries } from './types.ts';

export const WEEK_SECONDS = 604_800;
export const DAY_SECONDS = 86_400;

/** Monday 00:00 UTC of the week containing `unixSeconds`, the boundary Skylight's Trends weeks and data retention use. */
export function weekStart(unixSeconds: number): number {
  const day = Math.floor(unixSeconds / DAY_SECONDS);
  // 1970-01-01 was a Thursday: day 0 is weekday 3 counting from Monday.
  return (day - ((day + 3) % 7)) * DAY_SECONDS;
}

export interface WeekStats {
  count: number;
  /** Request-weighted means of the daily (or hourly) percentiles: approximations, not exact weekly percentiles. */
  p50: number;
  p95: number;
}

export interface WeekData {
  start: number;
  end: number;
  /** App-wide, from hourly buckets; null without requests. */
  app: WeekStats | null;
  endpoints: Map<string, WeekStats>;
}

const weightedMean = (pairs: [value: number | null, weight: number][]) => {
  let sum = 0, weight = 0;
  for (const [value, w] of pairs) if (value !== null && Number.isFinite(value) && w > 0) { sum += value * w; weight += w; }
  return weight ? sum / weight : 0;
};

/** Combines daily endpoint lists into weekly stats per endpoint. */
export function aggregateEndpointDays(days: readonly (readonly EndpointHighlight[])[]): Map<string, WeekStats> {
  const byName = new Map<string, EndpointHighlight[]>();
  for (const day of days) for (const e of day) if (e.count > 0) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  return new Map([...byName].map(([name, list]) => [name, {
    count: list.reduce((sum, e) => sum + e.count, 0),
    p50: weightedMean(list.map(e => [e.latencyP50, e.count])),
    p95: weightedMean(list.map(e => [e.latencyP95, e.count])),
  }]));
}

export function aggregateAppSeries(series: TrendSeries): WeekStats | null {
  const count = series.counts.reduce((sum, c) => sum + c, 0);
  if (!count) return null;
  return {
    count,
    p50: weightedMean(series.latenciesP50.map((v, i) => [v, series.counts[i] ?? 0])),
    p95: weightedMean(series.latenciesP95.map((v, i) => [v, series.counts[i] ?? 0])),
  };
}

export interface WeeklyChange {
  name: string;
  before: number;
  after: number;
  /** after / before - 1. */
  change: number;
  /** Requests per minute this week. */
  rpm: number;
  /** (after - before) × rpm: request time added (negative: saved) per minute. */
  impactMsPerMinute: number;
}

export interface FrogBoil extends WeeklyChange {
  /** The percentile each week, oldest first. */
  series: number[];
}

export interface PercentileReport {
  percentile: 50 | 95;
  /** App-wide, last week and this week. */
  before: number | null;
  after: number | null;
  /** null without both weeks; within ±5% counts as no change. */
  change: number | null;
  changed: boolean;
  slowdowns: WeeklyChange[];
  improved: WeeklyChange[];
  boils: FrogBoil[];
}

export interface WeeklyReport {
  start: number;
  end: number;
  requests: { before: number | null; after: number | null };
  /** Weeks with data used for frog boils (up to the requested number). */
  boilWeeks: number;
  reports: [PercentileReport, PercentileReport];
}

export interface WeeklyReportOptions {
  /** Requests an endpoint needs in each compared week. Default 100. */
  minRequests?: number;
  /** Relative change for an endpoint to count as slower or faster. Default 0.1. */
  minChange?: number;
  /** Frog boils: total rise over the weeks. Default 0.2. */
  minBoil?: number;
  /** Entries per list. Default 5. */
  limit?: number;
}

/**
 * Builds the report for the last week in `weeks` (oldest first), comparing it with the one before, and finding frog
 * boils across all of them: endpoints that got slower in all but at most one week-over-week step and by `minBoil`
 * overall.
 */
export function weeklyReport(weeks: readonly WeekData[], { minRequests = 100, minChange = 0.1, minBoil = 0.2, limit = 5 }: WeeklyReportOptions = {}): WeeklyReport {
  const current = weeks.at(-1);
  if (!current) throw new RangeError('weeklyReport needs at least one week');
  const previous = weeks.at(-2);
  const minutes = (current.end - current.start) / 60;
  const withData = weeks.filter(w => w.endpoints.size > 0);
  const report = (percentile: 50 | 95): PercentileReport => {
    const key = percentile === 50 ? 'p50' : 'p95';
    const before = previous?.app?.[key] ?? null, after = current.app?.[key] ?? null;
    const change = before && after !== null ? after / before - 1 : null;
    const changes: WeeklyChange[] = [];
    for (const [name, now] of current.endpoints) {
      const then = previous?.endpoints.get(name);
      if (!then || then.count < minRequests || now.count < minRequests || !then[key]) continue;
      const rpm = now.count / minutes;
      changes.push({ name, before: then[key], after: now[key], change: now[key] / then[key] - 1, rpm, impactMsPerMinute: (now[key] - then[key]) * rpm });
    }
    const boils: FrogBoil[] = [];
    if (withData.length >= 3 && withData.length === weeks.length) {
      for (const [name, now] of current.endpoints) {
        const series = weeks.map(w => w.endpoints.get(name));
        if (series.some(s => !s || s.count < minRequests)) continue;
        const values = series.map(s => s![key]);
        const rises = values.slice(1).filter((v, i) => v > values[i]!).length;
        const first = values[0]!, last = values.at(-1)!;
        if (!first || rises < values.length - 2 || last / first - 1 < minBoil) continue;
        const rpm = now.count / minutes;
        boils.push({ name, series: values, before: first, after: last, change: last / first - 1, rpm, impactMsPerMinute: (last - first) * rpm });
      }
    }
    return {
      percentile, before, after, change, changed: change !== null && Math.abs(change) >= 0.05,
      slowdowns: changes.filter(c => c.change >= minChange).sort((a, b) => b.impactMsPerMinute - a.impactMsPerMinute).slice(0, limit),
      improved: changes.filter(c => c.change <= -minChange).sort((a, b) => a.impactMsPerMinute - b.impactMsPerMinute).slice(0, limit),
      boils: boils.sort((a, b) => b.impactMsPerMinute - a.impactMsPerMinute).slice(0, limit),
    };
  };
  return {
    start: current.start, end: current.end,
    requests: { before: previous?.app?.count ?? null, after: current.app?.count ?? null },
    boilWeeks: withData.length === weeks.length ? weeks.length : 0,
    reports: [report(50), report(95)],
  };
}
