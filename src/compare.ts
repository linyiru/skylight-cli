import type { RankedEndpoint } from './rank.ts';

export interface EndpointChange {
  name: string;
  before: RankedEndpoint;
  after: RankedEndpoint;
  /** after - before, ms. */
  p50Delta: number;
  p95Delta: number;
  /** Relative change, e.g. 0.25 for 25% slower; null when the before value is 0. */
  p50Change: number | null;
  p95Change: number | null;
  /**
   * Request time added (or saved, if negative) per minute: the p50 change times the after rpm. Ranks by what users
   * feel in total, so a busy endpoint slowing a little outranks a rare one swinging a lot.
   */
  impactMsPerMinute: number;
}

export interface WindowComparison {
  /** Endpoints with enough requests in both windows, most added time first. */
  changed: EndpointChange[];
  /** Endpoints with requests only after, e.g. new routes; busiest first. */
  appeared: RankedEndpoint[];
  /** Endpoints with requests only before; busiest first. */
  disappeared: RankedEndpoint[];
}

const relative = (before: number, after: number) => (before ? (after - before) / before : null);

/**
 * Compares two endpoint lists, e.g. before and after a deploy. Endpoints need `minRequests` in each window to be
 * compared; percentiles from a handful of requests are noise.
 */
export function compareEndpoints(before: readonly RankedEndpoint[], after: readonly RankedEndpoint[], { minRequests = 20 } = {}):
  WindowComparison {
  const earlier = new Map(before.filter(e => e.count > 0).map(e => [e.name, e]));
  const later = new Map(after.filter(e => e.count > 0).map(e => [e.name, e]));
  const changed: EndpointChange[] = [];
  for (const [name, next] of later) {
    const previous = earlier.get(name);
    if (!previous || previous.count < minRequests || next.count < minRequests) continue;
    const p50Delta = next.latencyP50 - previous.latencyP50;
    changed.push({
      name, before: previous, after: next, p50Delta, p95Delta: next.latencyP95 - previous.latencyP95,
      p50Change: relative(previous.latencyP50, next.latencyP50), p95Change: relative(previous.latencyP95, next.latencyP95),
      impactMsPerMinute: p50Delta * next.rpm,
    });
  }
  const busiest = (a: RankedEndpoint, b: RankedEndpoint) => b.count - a.count;
  return {
    changed: changed.sort((a, b) => b.impactMsPerMinute - a.impactMsPerMinute),
    appeared: [...later.values()].filter(e => !earlier.has(e.name)).sort(busiest),
    disappeared: [...earlier.values()].filter(e => !later.has(e.name)).sort(busiest),
  };
}
