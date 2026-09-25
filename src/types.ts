/** Wire formats observed on 2026-09-25; not a published API contract. */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** The three credentials are sent raw in `Authorization` (no `Bearer`) and are not interchangeable. */
export type McpToken = Brand<string, 'McpToken'>;
export type SessionToken = Brand<string, 'SessionToken'>;
export type ClientApiToken = Brand<string, 'ClientApiToken'>;

/** GET www/mcp/authenticate. Each call issues a new session token. */
export interface WireAuthResponse {
  session: {
    token: SessionToken;
    /** Seconds the session stays valid (10800 observed) and when that ends (unix seconds). */
    expiry_ttl?: number;
    expiry_ts?: number;
    /** Seconds until a refresh is due (4500 observed) and when (unix seconds). */
    refresh_ttl?: number;
    refresh_ts?: number;
  };
  data_url: string;
}

export interface WireComponent {
  guid: string;
  name: string;
  environment: string;
  slug: string;
  client_api_token?: { token: ClientApiToken; expires: number };
}

export interface WireApp {
  guid: string;
  name: string;
  organization?: { guid: string; locked: boolean };
  components: WireComponent[];
}

/** GET www/mcp/apps. Each call issues new client API tokens. */
export interface WireAppsResponse {
  data_url?: string;
  apps: WireApp[];
}

export interface EndpointHighlight {
  /** Canonical name, possibly with a `<sk-segment>…</sk-segment>` suffix. */
  name: string;
  count: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  inspections: { objectAllocations?: number; nPlusOneQuery?: number };
}

/** POST {data_url}/apps/{component}/endpoint_highlights */
export interface WireEndpointHighlightsResponse {
  timestamp: number;
  duration: number;
  endpoints: EndpointHighlight[];
}

/** JSON:API resource from GET www/deploys. */
export interface Deploy {
  id: string;
  type: string;
  attributes: {
    start_at: string;
    end_at: string | null;
    deploy_id: string;
    git_sha: string;
    description: string | null;
  };
  relationships?: Record<string, { data: { type: string; id: string } }>;
}

export interface WireDeploysResponse {
  data: Deploy[];
  meta: Record<string, unknown>;
}

/** Component metadata without credentials. */
export interface Component {
  guid: string;
  name: string;
  environment: string;
  slug: string;
  appGuid: string;
  appName: string;
}

export interface App {
  guid: string;
  name: string;
  components: Component[];
}

export interface EndpointList {
  timestamp: number;
  duration: number;
  /** Matching endpoints before `limit`. */
  total: number;
  endpoints: EndpointHighlight[];
}

export interface DeployList {
  /** Deploys before `limit`. */
  total: number;
  data: Deploy[];
  meta: Record<string, unknown>;
}

/** One bucketed series; every array has `duration / step` entries, oldest first. */
export interface TrendSeries {
  timestamp: number;
  duration: number;
  step: number;
  counts: number[];
  latenciesP50: (number | null)[];
  latenciesP90: (number | null)[];
  latenciesP95: (number | null)[];
  latenciesP98: (number | null)[];
  latenciesP99: (number | null)[];
  latenciesMax: (number | null)[];
}

/** POST {data_url}/apps/{component}/application_highlights, body `{ranges: TrendRange[]}`. */
export interface WireTrendsResponse {
  ranges: TrendSeries[];
}

/**
 * Quantile digest. Each node counts samples in `[lower, lower + 2 ** level)`; node counts sum to `count`.
 */
export interface QDigest {
  count: number;
  min: number;
  max: number;
  nodes: [lower: number, level: number, count: number][];
}

export interface Inspection {
  /** e.g. `nPlusOneQuery`. */
  type: string;
  severity: number;
  /** `[category, title, detail]`, e.g. `['db.sql.query', 'SELECT FROM users', '<sql>']`. */
  event: [category: string, title: string | null, detail: string | null];
  durations: QDigest;
  /** Repetitions per request. */
  repetitions: QDigest;
}

/** A latency bucket `[start, start + length)` in ms from which trace samples were drawn. */
export interface TraceTarget {
  start: number;
  length: number;
  requests: unknown[];
}

/** `[1, samples, offset from the parent's allocations, allocations]` or `[2, [[deploy ref, source location id]]]`. */
export type TraceAnnotation =
  | [kind: 1, samples: number, allocationOffset: number, allocations: number]
  | [kind: 2, sources: [deployRef: string, sourceLocationId: string | null][]];

/**
 * One node's timing within one target bucket; averages when `samples` > 1. Offsets are relative to the parent
 * node. Decoded 2026-09-25 by comparing API responses with the Skylight UI; the unnamed fields are still unknown.
 */
export type TraceSpan = [
  target: number,
  samples: number,
  unknown2: number,
  unknown3: number,
  startMs: number,
  durationMs: number,
  /** Non-zero only when samples > 1. */
  unknown6: number,
  annotations: TraceAnnotation[],
];

/** `[parent index or null for the root, category, title, description (e.g. SQL), spans]`. */
export type TraceNode = [parent: number | null, category: string, title: string | null, description: string | null, spans: TraceSpan[]];

/** POST {data_url}/apps/{component}/endpoints/{encodeURIComponent(name)}/summary, body `{timestamp, duration}`. */
export interface EndpointSummary {
  endpoint: { name: string; timestamp: number; duration: number; count: number; latencies: QDigest };
  inspections: { timestamp: number; duration: number; results: Inspection[] };
  trace: { count: number; timestamp: number; duration: number; nodes: TraceNode[]; targets: TraceTarget[] };
}

/** GET www/source_locations?filter[id]={component}:{digest},… (JSON:API). Unknown ids are simply absent. */
export interface WireSourceLocation {
  id: string;
  type: 'source_locations';
  attributes: {
    /** An app file path, a gem name, or `<synthetic>` for events without source. */
    name: string;
    digest: string;
    collector_id: string;
    created_at: string;
    updated_at: string;
  };
}

export interface WireSourceLocationsResponse {
  data: WireSourceLocation[];
  meta: Record<string, unknown>;
}
