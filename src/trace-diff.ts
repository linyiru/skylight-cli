/**
 * Compares two aggregated traces of one endpoint, e.g. before and after a deploy, event by event. Events are matched
 * by their path from the root (category and title at each level), since node indexes differ between traces.
 */
import type { TraceTreeNode } from './trace.ts';

export interface TraceEventChange {
  /** Titles from the root to this event. */
  path: string[];
  before: TraceTreeNode | null;
  after: TraceTreeNode | null;
  /**
   * Self time this event adds to an average request, ms: self time × the share of requests that include it.
   * Summed over all events this is the average request duration, so the deltas add up to the endpoint's change.
   */
  beforeMs: number;
  afterMs: number;
  deltaMs: number;
}

export interface TraceDiff {
  /** Average request duration, ms. */
  before: number;
  after: number;
  /** Events in both traces, biggest change (either way) first. */
  changed: TraceEventChange[];
  /** Events only in the after trace (e.g. a new query), biggest first. */
  appeared: TraceEventChange[];
  /** Events only in the before trace, biggest first. */
  disappeared: TraceEventChange[];
}

const label = (node: TraceTreeNode) => node.title ?? node.category;
const contribution = (node: TraceTreeNode | null) => (node ? node.selfMs * node.occurrence : 0);

/** Every node keyed by its path; siblings with the same event keep their order by start time (#2, #3, …). */
function index(root: TraceTreeNode): Map<string, { node: TraceTreeNode; path: string[] }> {
  const nodes = new Map<string, { node: TraceTreeNode; path: string[] }>();
  const visit = (node: TraceTreeNode, key: string, path: string[]) => {
    nodes.set(key, { node, path });
    const seen = new Map<string, number>();
    for (const child of node.children) {
      const event = `${child.category}|${label(child)}`;
      const nth = (seen.get(event) ?? 0) + 1;
      seen.set(event, nth);
      visit(child, `${key}>${event}#${nth}`, [...path, nth > 1 ? `${label(child)} #${nth}` : label(child)]);
    }
  };
  visit(root, `${root.category}|${label(root)}`, [label(root)]);
  return nodes;
}

export function diffTraceTrees(before: TraceTreeNode, after: TraceTreeNode): TraceDiff {
  const earlier = index(before), later = index(after);
  const change = (key: string): TraceEventChange => {
    const b = earlier.get(key), a = later.get(key);
    const beforeMs = contribution(b?.node ?? null), afterMs = contribution(a?.node ?? null);
    return { path: (a ?? b)!.path, before: b?.node ?? null, after: a?.node ?? null, beforeMs, afterMs, deltaMs: afterMs - beforeMs };
  };
  const keys = new Set([...earlier.keys(), ...later.keys()]);
  const all = [...keys].map(change);
  const bySize = (a: TraceEventChange, b: TraceEventChange) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs);
  return {
    before: before.durationMs, after: after.durationMs,
    changed: all.filter(c => c.before && c.after).sort(bySize),
    appeared: all.filter(c => !c.before).sort(bySize),
    disappeared: all.filter(c => !c.after).sort(bySize),
  };
}
