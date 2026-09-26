import type { QDigest } from './types.ts';

const upperBound = ([lower, level]: [number, number, number]) => lower + 2 ** level - 1;

/**
 * Quantile of a q-digest, 0-1: the upper bound of the node where the cumulative count crosses q, clamped to
 * min/max. Matches the endpoint's own p50/p95 in the samples we checked, and is within a few ms at p99.
 */
export function digestQuantile(digest: QDigest, q: number): number | undefined {
  if (!(q >= 0 && q <= 1)) throw new RangeError('quantile must be within 0-1');
  const total = digest.nodes.reduce((sum, [, , count]) => sum + count, 0);
  if (!total) return undefined;
  const sorted = digest.nodes.toSorted((a, b) => upperBound(a) - upperBound(b) || a[1] - b[1]);
  let seen = 0;
  for (const node of sorted) {
    seen += node[2];
    if (seen >= q * total) return Math.min(digest.max, Math.max(digest.min, upperBound(node)));
  }
  return digest.max;
}

export interface HistogramBucket {
  /** Inclusive lower and exclusive upper bound, ms. */
  from: number;
  to: number;
  count: number;
}

/**
 * Buckets a q-digest between `from` and `to` (default: its 5th to 99th percentile). A node's count is spread
 * evenly over the values it covers, so wide nodes blur detail as they do in the UI's chart.
 */
export function digestHistogram(digest: QDigest, { buckets = 20, from, to }: { buckets?: number; from?: number; to?: number } = {}): HistogramBucket[] {
  const low = Math.floor(from ?? digestQuantile(digest, 0.05) ?? digest.min);
  const high = Math.max(low + 1, Math.ceil(to ?? digestQuantile(digest, 0.99) ?? digest.max));
  const width = Math.max(1, Math.ceil((high - low) / buckets));
  const result = Array.from({ length: Math.ceil((high - low) / width) }, (_, i) => ({ from: low + i * width, to: low + (i + 1) * width, count: 0 }));
  for (const [lower, level, count] of digest.nodes) {
    const upper = lower + 2 ** level; // exclusive
    for (const bucket of result) {
      const overlap = Math.min(upper, bucket.to) - Math.max(lower, bucket.from);
      if (overlap > 0) bucket.count += (count * overlap) / 2 ** level;
    }
  }
  return result;
}
