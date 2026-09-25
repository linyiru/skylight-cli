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

/** POST {data_url}/apps/{component}/endpoints/{encodeURIComponent(name)}/summary, body `{timestamp, duration}`. */
export interface EndpointSummary {
  endpoint: { name: string; timestamp: number; duration: number; count: number; latencies: QDigest };
  inspections: { timestamp: number; duration: number; results: Inspection[] };
  /** Positional trace tuples; the format is not decoded yet and may change. */
  trace: { count: number; timestamp: number; duration: number; nodes: unknown[]; targets: unknown[] };
}
