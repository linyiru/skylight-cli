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

export const ENDPOINT_SORT_KEYS = ['count', 'p50', 'p95', 'p99'] as const;
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
