/**
 * Upstream limits, verified against the live API on 2026-09-25 (see README).
 * Types and runtime validators both derive from these constants.
 */
import { SkylightError } from './errors.ts';

export interface WindowSpec {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** Windows are aligned down to whole minutes. */
export const WINDOW_GRANULARITY = 60;

/** endpoint_highlights: 1 minute to 24 hours, default 6 hours. */
export const ENDPOINT_WINDOW = { min: 60, max: 86_400, default: 21_600 } as const satisfies WindowSpec;

/** deploys: 1 minute to 180 days, default 45 days. */
export const DEPLOY_WINDOW = { min: 60, max: 15_552_000, default: 3_888_000 } as const satisfies WindowSpec;

/** Client-side row limit; upstream always returns the full list. */
export const LIMIT = { min: 1, max: 500, default: 20 } as const;

/** `agony` ranks like Skylight's endpoint list (ties by requests per minute); the rest sort descending. */
export const ENDPOINT_SORT_KEYS = ['agony', 'count', 'p50', 'p95', 'p99'] as const;
export type EndpointSortKey = (typeof ENDPOINT_SORT_KEYS)[number];

/** Unix seconds, or 'recent' for "now minus duration". */
export type WindowStart = number | 'recent';

export interface TimeWindow {
  timestamp: number;
  duration: number;
}

export function isEndpointSortKey(value: unknown): value is EndpointSortKey {
  return (ENDPOINT_SORT_KEYS as readonly unknown[]).includes(value);
}

export function timeWindow(timestamp: WindowStart, duration: number, spec: WindowSpec, now = Date.now()): TimeWindow {
  if (!Number.isInteger(duration) || duration < spec.min || duration > spec.max || duration % WINDOW_GRANULARITY) {
    throw new SkylightError('INVALID_DURATION');
  }
  const start = timestamp === 'recent' ? Math.floor(now / 1000) - duration : timestamp;
  if (!Number.isSafeInteger(start) || start < 0) throw new SkylightError('INVALID_TIMESTAMP');
  return { timestamp: Math.floor(start / WINDOW_GRANULARITY) * WINDOW_GRANULARITY, duration };
}

export function assertLimit(value: number): number {
  if (!Number.isInteger(value) || value < LIMIT.min || value > LIMIT.max) throw new SkylightError('INVALID_LIMIT');
  return value;
}

/** application_highlights accepts only these bucket sizes (seconds); others return 422 InvalidRangeStep. */
export const TREND_STEPS = [60, 600, 3_600] as const;
export type TrendStep = (typeof TREND_STEPS)[number];

/** Upstream rejects a request whose ranges sum (step × count) to more than 7 days. */
export const TREND_MAX_SECONDS_PER_REQUEST = 604_800;

/** Client-side cap matching the official MCP: 45 days, at most 7 requests at the hourly step. */
export const TREND_WINDOW = { min: 60, max: 3_888_000, default: 604_800 } as const satisfies WindowSpec;

export interface TrendRange {
  timestamp: number;
  step: TrendStep;
  count: number;
}

export function isTrendStep(value: unknown): value is TrendStep {
  return (TREND_STEPS as readonly unknown[]).includes(value);
}

/** Keeps tables around 100-170 rows: 1-minute buckets up to 2h, 10-minute up to 24h, hourly beyond. */
export function defaultTrendStep(duration: number): TrendStep {
  return duration <= 7_200 ? 60 : duration <= 86_400 ? 600 : 3_600;
}

/**
 * Splits a window into request-sized ranges. Explicit starts align down to the step; 'recent' ends at the
 * next step boundary, so the in-progress bucket is included.
 */
export function trendRanges(timestamp: WindowStart, duration: number, step: TrendStep, now = Date.now()): TrendRange[] {
  if (!isTrendStep(step)) throw new SkylightError('INVALID_STEP');
  if (!Number.isInteger(duration) || duration < TREND_WINDOW.min || duration > TREND_WINDOW.max || duration % step) {
    throw new SkylightError('INVALID_DURATION');
  }
  const start = timestamp === 'recent' ? Math.ceil(now / 1000 / step) * step - duration : timestamp;
  if (!Number.isSafeInteger(start) || start < 0) throw new SkylightError('INVALID_TIMESTAMP');
  const perRequest = TREND_MAX_SECONDS_PER_REQUEST / step;
  const ranges: TrendRange[] = [];
  for (let offset = 0, total = duration / step; offset < total; offset += perRequest) {
    ranges.push({ timestamp: Math.floor(start / step) * step + offset * step, step, count: Math.min(perRequest, total - offset) });
  }
  return ranges;
}

/** Source location ids per `filter[id]` request; 40 verified, kept conservative for URL length. */
export const SOURCE_LOCATION_BATCH = 50;
