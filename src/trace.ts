import type { TraceNode, TraceSpan, TraceTarget } from './types.ts';

/** One event in the aggregated trace. Times are ms, averaged over the sampled requests the node occurs in. */
export interface TraceTreeNode {
  /** Index into the upstream `trace.nodes`. */
  index: number;
  category: string;
  title: string | null;
  /** e.g. the SQL of a query. */
  description: string | null;
  /** Share of requests that contain this node, 0-1. */
  occurrence: number;
  /** Requests that contain this node. */
  samples: number;
  /** Offset from the start of the request. */
  startMs: number;
  durationMs: number;
  /** Duration minus the children's durations. */
  selfMs: number;
  allocations: number;
  /** `[deploy ref, source location id]` pairs, as shown in the UI as git sha and file:line. */
  sources: [deployRef: string, sourceLocationId: string | null][];
  children: TraceTreeNode[];
}

export interface TraceTreeOptions {
  /** Keep only samples from latency buckets matching this predicate (e.g. only slow requests). */
  targets?: (target: TraceTarget, index: number) => boolean;
}

interface Sample { start: number; duration: number; allocations: number; weight: number }

const allocationsOf = (span: TraceSpan) =>
  span[7]?.find((annotation): annotation is [1, number, number, number] => annotation[0] === 1)?.[3] ?? 0;

const sourcesOf = (span: TraceSpan) =>
  span[7]?.find((annotation): annotation is [2, [string, string | null][]] => annotation[0] === 2)?.[1] ?? [];

/**
 * Aggregates the per-bucket spans of an endpoint summary into one tree, like the Skylight UI's event sequence.
 * Self time is computed per bucket (a node's duration minus its children's in the same bucket), then averaged,
 * so it stays exact where averaging first would not. Returns undefined when the trace has no samples.
 */
export function buildTraceTree(trace: { nodes: TraceNode[]; targets: TraceTarget[] }, options: TraceTreeOptions = {}): TraceTreeNode | undefined {
  const { nodes, targets } = trace;
  const included = new Set(targets.map((target, i) => [target, i] as const)
    .filter(([target, i]) => options.targets?.(target, i) ?? true).map(([, i]) => i));
  const children = nodes.map(() => [] as number[]);
  let root: number | undefined;
  nodes.forEach(([parent], i) => {
    if (parent === null) root ??= i;
    else children[parent]?.push(i);
  });
  if (root === undefined) return undefined;

  // Per node, per bucket: absolute start, duration, allocations, and sample weight.
  const perTarget = nodes.map(() => new Map<number, Sample>());
  const visit = (index: number, parentStarts: Map<number, number>) => {
    const starts = new Map<number, number>();
    for (const span of nodes[index]![4] ?? []) {
      const [target, samples, , , start, duration] = span;
      if (!included.has(target)) continue;
      const absolute = (parentStarts.get(target) ?? 0) + start;
      starts.set(target, absolute);
      perTarget[index]!.set(target, { start: absolute, duration, allocations: allocationsOf(span), weight: samples });
    }
    for (const child of children[index]!) visit(child, starts);
  };
  visit(root, new Map());

  const rootSamples = [...perTarget[root]!.values()].reduce((sum, s) => sum + s.weight, 0);
  const build = (index: number): TraceTreeNode => {
    const [, category, title, description, spans] = nodes[index]!;
    const samples = [...perTarget[index]!.entries()];
    const weight = samples.reduce((sum, [, s]) => sum + s.weight, 0);
    const mean = (value: (target: number, sample: Sample) => number) =>
      weight ? samples.reduce((sum, [target, s]) => sum + value(target, s) * s.weight, 0) / weight : 0;
    const childrenDuration = (target: number) =>
      children[index]!.reduce((sum, child) => sum + (perTarget[child]!.get(target)?.duration ?? 0), 0);
    const sources = new Map<string, [string, string | null]>();
    for (const span of spans ?? []) for (const pair of sourcesOf(span)) sources.set(pair.join('\0'), pair);
    return {
      index, category, title, description,
      occurrence: rootSamples ? Math.min(1, weight / rootSamples) : 0,
      samples: weight,
      startMs: mean((_, s) => s.start),
      durationMs: mean((_, s) => s.duration),
      selfMs: mean((target, s) => Math.max(0, s.duration - childrenDuration(target))),
      allocations: mean((_, s) => s.allocations),
      sources: [...sources.values()],
      children: children[index]!.filter(child => perTarget[child]!.size > 0).map(build)
        .sort((a, b) => a.startMs - b.startMs),
    };
  };
  return build(root);
}

export interface CondenseOptions {
  /** Pass-through wrappers with less self time than this are folded into their only child. Default 0.5 ms. */
  maxSelfMs?: number;
  /** Categories that may be folded. Default: Rack middleware and the router. */
  categories?: readonly string[];
  /** Drop subtrees shorter than this on average. Default 0 (keep everything). */
  minDurationMs?: number;
  /** Drop subtrees seen in fewer than this share of requests, 0-1. Default 0 (keep everything). */
  minOccurrence?: number;
}

/** Number of nodes in a tree, including the root. */
export const countTraceNodes = (node: TraceTreeNode): number => 1 + node.children.reduce((sum, c) => sum + countTraceNodes(c), 0);

/**
 * Like the UI's "Condense trace": folds chains of wrappers that do almost nothing themselves (typically Rack
 * middleware) into their child, and optionally drops short or rare subtrees.
 */
export function condenseTraceTree(node: TraceTreeNode, options: CondenseOptions = {}): TraceTreeNode {
  const { maxSelfMs = 0.5, categories = ['rack.middleware', 'rack.app'], minDurationMs = 0, minOccurrence = 0 } = options;
  const condense = (current: TraceTreeNode, isRoot: boolean): TraceTreeNode => {
    const kept = current.children.filter(child => child.durationMs >= minDurationMs && child.occurrence >= minOccurrence);
    if (!isRoot && kept.length === 1 && current.selfMs < maxSelfMs && categories.includes(current.category)) {
      return condense(kept[0]!, false);
    }
    return { ...current, children: kept.map(child => condense(child, false)) };
  };
  return condense(node, true);
}
