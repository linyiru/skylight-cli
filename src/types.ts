/** Wire formats observed on 2026-09-25; not a published API contract. */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** The three credentials are sent raw in `Authorization` (no `Bearer`) and are not interchangeable. */
export type McpToken = Brand<string, 'McpToken'>;
export type SessionToken = Brand<string, 'SessionToken'>;
export type ClientApiToken = Brand<string, 'ClientApiToken'>;

/** GET www/mcp/authenticate */
export interface WireAuthResponse {
  session: { token: SessionToken; refresh_ttl?: number };
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

/** GET www/mcp/apps */
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
