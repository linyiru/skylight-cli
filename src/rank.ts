/**
 * Endpoint grades, agony, and popularity as computed by Skylight's web UI (direwolf `models/endpoints-list` and
 * `system/grades`, read 2026-09-25). All scores are relative to the other active endpoints in the same window.
 */
import type { EndpointHighlight } from './types.ts';

/** Upper p50 bound (ms, inclusive) for each letter grade; slower than the last bound is F. */
export const GRADE_THRESHOLDS = [[3, 'A+'], [9, 'A'], [17, 'A-'], [26, 'B+'], [38, 'B'], [55, 'B-'], [83, 'C+'],
  [127, 'C'], [189, 'C-'], [314, 'D+'], [709, 'D']] as const;
export type Grade = (typeof GRADE_THRESHOLDS)[number][1] | 'F';

export interface RankedEndpoint extends EndpointHighlight {
  /** Requests per minute over the window. */
  rpm: number;
  /** Letter grade from the typical (p50) response time. */
  grade: Grade;
  /**
   * 0-3: the minimum of how high rpm, p50, and p95 each rank among active endpoints (above the 80th, 50th, 20th
   * percentile scores 3, 2, 1). High only when an endpoint is busy, typically slow, and slow in the tail.
   */
  agony: number;
  /** 1-10 on a log scale of rpm relative to the busiest endpoint. */
  popularity: number;
  /** Among the top 5% by total allocations, and over 10,000 objects per request. */
  highAllocations: boolean;
  /** The name without its `<sk-segment>` variant; all variants of one route share it. */
  baseName: string;
  /** e.g. `json`, `html`, `error`; null for names without a variant. */
  segment: string | null;
  /**
   * Share of the route's requests (all its variants) that were errors, 0-1. Skylight files error responses under
   * the `error` variant, so this is the same for every variant of a route.
   */
  errorRate: number;
  /** Error responses per minute across the route. */
  errorsPerMinute: number;
}

const SEGMENT = /<sk-segment>(.*)<\/sk-segment>$/;

/** Splits `Name<sk-segment>json</sk-segment>` into the route and its response variant. */
export function splitEndpointName(name: string): { baseName: string; segment: string | null } {
  const match = SEGMENT.exec(name);
  return match ? { baseName: name.slice(0, match.index), segment: match[1]! } : { baseName: name, segment: null };
}

/** Skylight's variant for error responses. */
export const ERROR_SEGMENT = 'error';

export function gradeFor(p50: number): Grade {
  return GRADE_THRESHOLDS.find(([bound]) => p50 <= bound)?.[1] ?? 'F';
}

/** Nearest-rank percentile of ascending values (Skylight estimates the same with a q-digest). */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

function rankScore(sorted: readonly number[], value: number): number {
  return value > percentile(sorted, 80) ? 3 : value > percentile(sorted, 50) ? 2 : value > percentile(sorted, 20) ? 1 : 0;
}

const ascending = (values: number[]) => values.sort((a, b) => a - b);

/**
 * Annotates endpoints with the UI's scores. Pass the full list for the window, before any search or limit, since
 * scores compare endpoints with each other. Endpoints without requests score 0 and grade from their p50.
 */
export function rankEndpoints(endpoints: readonly EndpointHighlight[], durationSeconds: number): RankedEndpoint[] {
  const rpmOf = (e: EndpointHighlight) => e.count * (60 / durationSeconds);
  const active = endpoints.filter(e => e.count > 0);
  const rpms = ascending(active.map(rpmOf));
  const p50s = ascending(active.map(e => e.latencyP50));
  const p95s = ascending(active.map(e => e.latencyP95));
  const totalAllocations = ascending(active.map(e => (e.inspections?.objectAllocations ?? 0) * rpmOf(e)));
  const maxRpm = rpms.at(-1) ?? 0;
  const allocationCutoff = percentile(totalAllocations, 95);
  const routes = new Map<string, { requests: number; errors: number }>();
  for (const e of active) {
    const { baseName, segment } = splitEndpointName(e.name);
    const route = routes.get(baseName) ?? { requests: 0, errors: 0 };
    route.requests += e.count;
    if (segment === ERROR_SEGMENT) route.errors += e.count;
    routes.set(baseName, route);
  }
  return endpoints.map(endpoint => {
    const { baseName, segment } = splitEndpointName(endpoint.name);
    const route = routes.get(baseName);
    const rpm = rpmOf(endpoint);
    const perRequest = endpoint.inspections?.objectAllocations ?? 0;
    const scaled = maxRpm ? 1 + (rpm / maxRpm) * 999 : 1;
    const popularity = Math.round((0.1 + 0.9 * (Math.log(scaled) / Math.log(1000))) * 10);
    return {
      ...endpoint, rpm, grade: gradeFor(endpoint.latencyP50),
      agony: endpoint.count > 0 ? Math.min(rankScore(rpms, rpm), rankScore(p50s, endpoint.latencyP50), rankScore(p95s, endpoint.latencyP95)) : 0,
      popularity: endpoint.count > 0 ? popularity : 0,
      highAllocations: endpoint.count > 0 && perRequest * rpm >= allocationCutoff && perRequest > 10_000,
      baseName, segment, errorRate: route?.requests ? route.errors / route.requests : 0,
      errorsPerMinute: (route?.errors ?? 0) * (60 / durationSeconds),
    };
  });
}
