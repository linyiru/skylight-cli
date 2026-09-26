import { githubFileUrl, type GithubLocation } from './github.ts';
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
  /** Times the event repeats per request (e.g. an N+1 query), averaged; and the most seen. */
  repetitions: number;
  maxRepetitions: number;
  /** `[deploy ref, source location id]` pairs, as shown in the UI as git sha and file:line. */
  sources: [deployRef: string, sourceLocationId: string | null][];
  children: TraceTreeNode[];
}

export interface TraceTreeOptions {
  /** Keep only samples from latency buckets matching this predicate (e.g. only slow requests). */
  targets?: (target: TraceTarget, index: number) => boolean;
}

interface Sample { start: number; duration: number; allocations: number; repetitions: number; maxRepetitions: number; weight: number }

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
      const [target, samples, repetitions, maxRepetitions, start, duration] = span;
      if (!included.has(target)) continue;
      const absolute = (parentStarts.get(target) ?? 0) + start;
      starts.set(target, absolute);
      perTarget[index]!.set(target, { start: absolute, duration, allocations: allocationsOf(span), repetitions,
        maxRepetitions, weight: samples });
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
    // A child may run in only some of this bucket's requests: weight its duration by that share.
    const childrenDuration = (target: number, own: Sample) => children[index]!.reduce((sum, child) => {
      const sample = perTarget[child]!.get(target);
      return sample && own.weight ? sum + sample.duration * Math.min(1, sample.weight / own.weight) : sum;
    }, 0);
    const sources = new Map<string, [string, string | null]>();
    for (const span of spans ?? []) for (const pair of sourcesOf(span)) sources.set(pair.join('\0'), pair);
    return {
      index, category, title, description,
      occurrence: rootSamples ? Math.min(1, weight / rootSamples) : 0,
      samples: weight,
      startMs: mean((_, s) => s.start),
      durationMs: mean((_, s) => s.duration),
      selfMs: mean((target, s) => Math.max(0, s.duration - childrenDuration(target, s))),
      allocations: mean((_, s) => s.allocations),
      repetitions: mean((_, s) => s.repetitions),
      maxRepetitions: samples.reduce((max, [, s]) => Math.max(max, s.maxRepetitions), 0),
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

/** A trace annotation's source value, `digest` (gem) or `digest:line` (app code), with its deploy. */
export interface TraceSourceRef {
  deployRef: string;
  digest: string;
  /** Present for app code, absent for gems and synthetic events. */
  line: number | null;
}

export function parseTraceSource([deployRef, value]: [string, string | null]): TraceSourceRef | undefined {
  if (!value) return undefined;
  const [digest = '', line] = value.split(':');
  return digest ? { deployRef, digest, line: line ? Number.parseInt(line, 10) : null } : undefined;
}

/** Source digests and deploy refs used anywhere in a tree, for batch lookups. */
export function traceSourceRefs(node: TraceTreeNode): { digests: string[]; deployRefs: string[] } {
  const digests = new Set<string>(), deployRefs = new Set<string>();
  const visit = (current: TraceTreeNode) => {
    for (const pair of current.sources) {
      const ref = parseTraceSource(pair);
      if (ref) { digests.add(ref.digest); deployRefs.add(ref.deployRef); }
    }
    current.children.forEach(visit);
  };
  visit(node);
  return { digests: [...digests], deployRefs: [...deployRefs] };
}

export interface TraceSourceLocation {
  /** App file path or gem name; null when Skylight has no record of the digest. */
  name: string | null;
  line: number | null;
  /** App code (has a line) rather than a gem. */
  inApp: boolean;
  deployRef: string;
  gitSha: string | null;
  /** GitHub link to the line at that deploy, for app code when a repo was given. */
  url: string | null;
}

export interface LocatedTraceTreeNode extends Omit<TraceTreeNode, 'children'> {
  /** App code first, unresolved names last; synthetic events are left out. */
  locations: TraceSourceLocation[];
  children: LocatedTraceTreeNode[];
}

/**
 * Attaches resolved source names (by digest) and deploy git shas (by deploy ref) to every node, and GitHub links
 * for app code when a repo is given (`owner/name`, or a `GithubLocation` for an app in a subdirectory).
 */
export function locateTraceTree(node: TraceTreeNode, names: ReadonlyMap<string, string>,
  gitShas: ReadonlyMap<string, string> = new Map(), repo?: string | GithubLocation): LocatedTraceTreeNode {
  const locations = node.sources.map(parseTraceSource)
    .filter((ref): ref is TraceSourceRef => ref !== undefined)
    .map(ref => {
      const name = names.get(ref.digest) ?? null, gitSha = gitShas.get(ref.deployRef) ?? null;
      // Gems live outside the app's repo, so only app code (which has a line) gets a link.
      const url = repo && name && gitSha && ref.line !== null ? githubFileUrl(repo, gitSha, name, ref.line) : null;
      return { name, line: ref.line, inApp: ref.line !== null, deployRef: ref.deployRef, gitSha, url };
    })
    .filter(location => location.name !== '<synthetic>')
    .sort((a, b) => Number(b.inApp) - Number(a.inApp) || Number(a.name === null) - Number(b.name === null)
      || (a.name ?? '').localeCompare(b.name ?? '') || (a.line ?? 0) - (b.line ?? 0));
  return { ...node, locations, children: node.children.map(child => locateTraceTree(child, names, gitShas, repo)) };
}

/** Skylight's time breakdown groups; everything else (rack, noise, agent, api, …) counts as `other`. */
export const BREAKDOWN_GROUPS = ['app', 'db', 'view'] as const;
export type Breakdown = Record<(typeof BREAKDOWN_GROUPS)[number] | 'other', number>;

/**
 * Share of the request's time spent in each group, in whole percent, like the UI's App / DB / View / Other bar:
 * self time per event, weighted by how many requests include it, summed by the category's first segment.
 * Pass the uncondensed tree, or folded middleware drops out.
 */
export function timeBreakdown(node: TraceTreeNode): Breakdown {
  const sums = new Map<string, number>();
  let total = 0;
  const visit = (current: TraceTreeNode) => {
    const group = current.category.split('.')[0]!;
    const weighted = current.selfMs * current.samples;
    sums.set(group, (sums.get(group) ?? 0) + weighted);
    total += weighted;
    current.children.forEach(visit);
  };
  visit(node);
  const result: Breakdown = { app: 0, db: 0, view: 0, other: 0 };
  for (const [group, sum] of sums) {
    const percent = total ? Math.round((sum / total) * 100) : 0;
    if ((BREAKDOWN_GROUPS as readonly string[]).includes(group)) result[group as keyof Breakdown] = percent;
    else result.other += percent;
  }
  return result;
}

/** App events with more than a quarter of the request as self time: the UI suggests custom instrumentation there. */
export function needsInstrumentation(node: TraceTreeNode, root: TraceTreeNode = node): TraceTreeNode[] {
  const own = node.category.startsWith('app') && root.durationMs > 0
    && (node.selfMs * node.samples) / (root.durationMs * root.samples) > 0.25 ? [node] : [];
  return [...own, ...node.children.flatMap(child => needsInstrumentation(child, root))];
}
