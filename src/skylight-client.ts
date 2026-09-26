import { SkylightError } from './errors.ts';
import { rankEndpoints, type RankedEndpoint } from './rank.ts';
import { DAY_SECONDS, WEEK_SECONDS, aggregateAppSeries, aggregateEndpointDays, weekStart, type WeekData } from './weekly.ts';
import {
  DEPLOY_WINDOW, ENDPOINT_WINDOW, LIMIT, SOURCE_LOCATION_BATCH, TREND_WINDOW, assertLimit, defaultTrendStep, isEndpointSortKey, timeWindow,
  trendRanges, type EndpointSortKey, type TimeWindow, type TrendStep, type WindowStart,
} from './spec.ts';
import type {
  App, ClientApiToken, Component, Deploy, DeployList, EndpointHighlight, EndpointList, EndpointSummary, McpToken,
  SessionToken, TrendSeries, WireApp, WireAppsResponse, WireAuthResponse, WireComponent, WireDeploysResponse,
  WireEndpointHighlightsResponse, WireSourceLocationsResponse, WireTrendsResponse,
} from './types.ts';

const WEB_URL = 'https://www.skylight.io';

const byDescending = (field: keyof RankedEndpoint) => (a: RankedEndpoint, b: RankedEndpoint) =>
  (Number(b[field]) || 0) - (Number(a[field]) || 0);

const SORTS: Record<EndpointSortKey, (a: RankedEndpoint, b: RankedEndpoint) => number> = {
  agony: (a, b) => b.agony - a.agony || b.rpm - a.rpm,
  count: byDescending('count'), p50: byDescending('latencyP50'), p95: byDescending('latencyP95'), p99: byDescending('latencyP99'),
};

type AnyToken = McpToken | SessionToken | ClientApiToken;

export interface SkylightClientOptions {
  /** Defaults to `process.env.SKYLIGHT_MCP_TOKEN`. */
  token?: string | undefined;
  fetch?: typeof globalThis.fetch;
}

export interface ListOptions {
  refresh?: boolean;
}

export interface WindowOptions {
  /** Component guid; optional when the account has exactly one component. */
  componentId?: string | undefined;
  timestamp?: WindowStart;
  /** Seconds, whole minutes. */
  duration?: number;
  limit?: number;
}

export interface ListEndpointsOptions extends WindowOptions {
  /** Case-insensitive name filter; `users#index` also matches `UsersController#index`. */
  search?: string | undefined;
  /** Descending by the given metric; default keeps upstream order. */
  sortBy?: EndpointSortKey | undefined;
}

export interface LatencyTrendsOptions extends Omit<WindowOptions, 'limit'> {
  /** Bucket size; defaults by window length (see `defaultTrendStep`). */
  step?: TrendStep | undefined;
}

export interface EndpointDetailOptions extends Omit<WindowOptions, 'limit'> {
  /** Canonical name exactly as listed, including any `<sk-segment>…</sk-segment>` suffix. */
  endpoint: string;
}

const SERIES_KEYS = ['counts', 'latenciesP50', 'latenciesP90', 'latenciesP95', 'latenciesP98', 'latenciesP99',
  'latenciesMax'] as const satisfies (keyof TrendSeries)[];

function isSeries(value: unknown, count: number): value is TrendSeries {
  const series = value as Partial<TrendSeries> | undefined;
  return !!series && SERIES_KEYS.every(key => Array.isArray(series[key]) && series[key].length === count);
}

function dataUrl(value: unknown): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw new SkylightError('INVALID_DATA_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== '443')
    || !(url.hostname === 'skylight.io' || url.hostname.endsWith('.skylight.io'))) {
    throw new SkylightError('INVALID_DATA_URL');
  }
  return url.href.replace(/\/$/, '');
}

// 'users#index' also matches 'UsersController#index' (Rails convention).
function endpointMatcher(search: string | undefined): (endpoint: EndpointHighlight) => boolean {
  if (search === undefined) return () => true;
  if (typeof search !== 'string' || !search.trim()) throw new SkylightError('INVALID_SEARCH');
  const needle = search.trim().toLowerCase();
  const [controller = '', action] = needle.split('#');
  const railsName = action !== undefined && !controller.endsWith('controller')
    ? `${controller}controller#${action}` : undefined;
  return endpoint => {
    const name = String(endpoint?.name ?? '').toLowerCase();
    return name.includes(needle) || (railsName !== undefined
      && (name.startsWith(railsName) || name.includes(`::${railsName}`)));
  };
}

function publicComponent(component: WireComponent, app: WireApp): Component {
  return {
    guid: component.guid, name: component.name, environment: component.environment,
    slug: component.slug, appGuid: app.guid, appName: app.name,
  };
}

/** Read-only client for the HTTP endpoints observed in the official MCP. */
export class SkylightClient {
  #token: McpToken;
  #fetch: typeof globalThis.fetch;
  #session: SessionToken | undefined;
  #dataUrl: string | undefined;
  #apps: WireApp[] | undefined;
  #authPromise: Promise<void> | undefined;

  constructor({ token = process.env.SKYLIGHT_MCP_TOKEN, fetch: fetchImpl = globalThis.fetch }: SkylightClientOptions = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
      throw new SkylightError('MISSING_OR_INVALID_TOKEN');
    }
    this.#token = token as McpToken;
    this.#fetch = fetchImpl;
  }

  async #request<T>(url: string, token: AnyToken, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        // Match the official client: /deploys rejects application/json (406).
        headers: { authorization: token, accept: '*/*',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new SkylightError('NETWORK_ERROR'); }
    if (!response.ok) {
      // Do not expose server error bodies or credentials via exception causes. Discard without awaiting:
      // cancellation is best effort and must not delay the error.
      response.body?.cancel().catch(() => {});
      throw new SkylightError('HTTP_ERROR', response.status);
    }
    try { return await response.json() as T; } catch { throw new SkylightError('INVALID_JSON'); }
  }

  async #authenticate(): Promise<void> {
    if (!this.#authPromise) {
      this.#authPromise = (async () => {
        const result = await this.#request<Partial<WireAuthResponse>>(`${WEB_URL}/mcp/authenticate`, this.#token);
        if (typeof result?.session?.token !== 'string' || !result.session.token) {
          throw new SkylightError('INVALID_AUTH_RESPONSE');
        }
        const origin = dataUrl(result.data_url);
        this.#session = result.session.token;
        this.#dataUrl = origin;
        this.#apps = undefined;
      })().finally(() => { this.#authPromise = undefined; });
    }
    await this.#authPromise;
  }

  async #run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#session) await this.#authenticate();
    try { return await operation(); } catch (error) {
      if (!(error instanceof SkylightError) || error.status !== 401) throw error;
      // Refresh the whole token chain once; never loop on invalid credentials.
      this.#session = undefined;
      this.#apps = undefined;
      await this.#authenticate();
      return operation();
    }
  }

  async #loadApps(refresh = false): Promise<WireApp[]> {
    if (!this.#apps || refresh) {
      const result = await this.#request<Partial<WireAppsResponse>>(`${WEB_URL}/mcp/apps`, this.#session!);
      if (!Array.isArray(result?.apps)
        || result.apps.some(app => !app || !Array.isArray(app.components)
          || app.components.some(component => !component || typeof component.guid !== 'string'))) {
        throw new SkylightError('INVALID_APPS_RESPONSE');
      }
      if (result.data_url) this.#dataUrl = dataUrl(result.data_url);
      this.#apps = result.apps;
    }
    return this.#apps;
  }

  async #component(componentId: string | undefined): Promise<WireComponent> {
    const apps = await this.#loadApps();
    const components = apps.flatMap(app => app.components);
    const selected = componentId === undefined
      ? (components.length === 1 ? components[0] : undefined)
      : components.find(component => component.guid === componentId);
    if (!selected) throw new SkylightError(componentId === undefined ? 'COMPONENT_SELECTION_REQUIRED' : 'COMPONENT_NOT_FOUND');
    return selected;
  }

  async #dataAccess(componentId: string | undefined): Promise<{ base: string; token: ClientApiToken }> {
    const component = await this.#component(componentId);
    const token = component.client_api_token?.token;
    if (typeof token !== 'string' || !token) throw new SkylightError('MISSING_COMPONENT_TOKEN');
    return { base: `${this.#dataUrl}/apps/${encodeURIComponent(component.guid)}`, token };
  }

  async #endpointHighlights(componentId: string | undefined, window: TimeWindow): Promise<WireEndpointHighlightsResponse> {
    const { base, token } = await this.#dataAccess(componentId);
    const result = await this.#request<Partial<WireEndpointHighlightsResponse>>(`${base}/endpoint_highlights`, token, window);
    if (!Array.isArray(result?.endpoints)) throw new SkylightError('INVALID_ENDPOINTS_RESPONSE');
    return { timestamp: result.timestamp ?? window.timestamp, duration: result.duration ?? window.duration, endpoints: result.endpoints };
  }

  /** Every endpoint in a window, unranked and unlimited (a busy app has over a thousand per day). */
  async getEndpointHighlights({ componentId, timestamp = 'recent', duration = ENDPOINT_WINDOW.default }: Omit<WindowOptions, 'limit'> = {}):
    Promise<WireEndpointHighlightsResponse> {
    const window = timeWindow(timestamp, duration, ENDPOINT_WINDOW);
    return this.#run(() => this.#endpointHighlights(componentId, window));
  }

  async listApps({ refresh = false }: ListOptions = {}): Promise<App[]> {
    return this.#run(async () => (await this.#loadApps(refresh)).map(app => ({
      guid: app.guid, name: app.name,
      components: app.components.map(component => publicComponent(component, app)),
    })));
  }

  async listComponents({ refresh = false }: ListOptions = {}): Promise<Component[]> {
    return (await this.listApps({ refresh })).flatMap(app => app.components);
  }

  async listEndpoints({
    componentId, timestamp = 'recent', duration = ENDPOINT_WINDOW.default, limit = LIMIT.default, search, sortBy,
  }: ListEndpointsOptions = {}): Promise<EndpointList> {
    const window = timeWindow(timestamp, duration, ENDPOINT_WINDOW);
    assertLimit(limit);
    const matches = endpointMatcher(search);
    if (sortBy !== undefined && !isEndpointSortKey(sortBy)) throw new SkylightError('INVALID_SORT');
    return this.#run(async () => {
      const result = await this.#endpointHighlights(componentId, window);
      // Score against the whole window first; search and limit only choose what to show.
      let endpoints = rankEndpoints(result.endpoints, result.duration).filter(matches);
      if (sortBy !== undefined) endpoints = endpoints.toSorted(SORTS[sortBy]);
      return { timestamp: result.timestamp, duration: result.duration, total: endpoints.length, endpoints: endpoints.slice(0, limit) };
    });
  }

  async listDeploys({
    componentId, timestamp = 'recent', duration = DEPLOY_WINDOW.default, limit = LIMIT.default,
  }: WindowOptions = {}): Promise<DeployList> {
    const window = timeWindow(timestamp, duration, DEPLOY_WINDOW);
    assertLimit(limit);
    return this.#run(async () => {
      const component = await this.#component(componentId);
      const url = new URL('/deploys', WEB_URL);
      url.search = new URLSearchParams({
        timestamp: String(window.timestamp), duration: String(window.duration), app_component_id: component.guid,
      }).toString();
      const result = await this.#request<Partial<WireDeploysResponse>>(url.href, this.#session!);
      if (!Array.isArray(result?.data)) throw new SkylightError('INVALID_DEPLOYS_RESPONSE');
      return { total: result.data.length, data: result.data.slice(0, limit), meta: result.meta ?? {} };
    });
  }

  /** App-wide latency series. Windows over 7 days are fetched as parallel requests and concatenated. */
  async getLatencyTrends({
    componentId, timestamp = 'recent', duration = TREND_WINDOW.default, step,
  }: LatencyTrendsOptions = {}): Promise<TrendSeries> {
    const bucket = step ?? defaultTrendStep(duration);
    const ranges = trendRanges(timestamp, duration, bucket);
    return this.#run(async () => {
      const { base, token } = await this.#dataAccess(componentId);
      const parts = await Promise.all(ranges.map(async range => {
        const result = await this.#request<Partial<WireTrendsResponse>>(`${base}/application_highlights`, token, { ranges: [range] });
        const series = result?.ranges?.[0];
        if (!isSeries(series, range.count)) throw new SkylightError('INVALID_TRENDS_RESPONSE');
        return series;
      }));
      const merged: TrendSeries = {
        timestamp: ranges[0]!.timestamp, duration: ranges.reduce((sum, range) => sum + range.step * range.count, 0), step: bucket,
        counts: [], latenciesP50: [], latenciesP90: [], latenciesP95: [], latenciesP98: [], latenciesP99: [], latenciesMax: [],
      };
      for (const part of parts) for (const key of SERIES_KEYS) (merged[key] as (number | null)[]).push(...part[key]);
      return merged;
    });
  }

  /** Latency digest, inspections (e.g. N+1 queries), and the raw trace for one endpoint. */
  async getEndpointDetail({
    componentId, endpoint, timestamp = 'recent', duration = ENDPOINT_WINDOW.default,
  }: EndpointDetailOptions): Promise<EndpointSummary> {
    if (typeof endpoint !== 'string' || !endpoint) throw new SkylightError('INVALID_ENDPOINT');
    const window = timeWindow(timestamp, duration, ENDPOINT_WINDOW);
    return this.#run(async () => {
      const { base, token } = await this.#dataAccess(componentId);
      const result = await this.#request<Partial<EndpointSummary>>(
        `${base}/endpoints/${encodeURIComponent(endpoint)}/summary`, token, window);
      if (typeof result?.endpoint?.latencies?.count !== 'number' || !Array.isArray(result.inspections?.results)) {
        throw new SkylightError('INVALID_SUMMARY_RESPONSE');
      }
      return result as EndpointSummary;
    });
  }

  /**
   * Resolves source location digests, as found in trace annotations, to names: an app file path, a gem name, or
   * `<synthetic>`. Keyed by digest; digests Skylight does not know are absent.
   */
  async getSourceLocations({ componentId, digests }: { componentId?: string | undefined; digests: readonly string[] }):
    Promise<Map<string, string>> {
    const unique = [...new Set(digests.filter(digest => typeof digest === 'string' && digest))];
    if (!unique.length) return new Map();
    return this.#run(async () => {
      const component = await this.#component(componentId);
      const names = new Map<string, string>();
      for (let i = 0; i < unique.length; i += SOURCE_LOCATION_BATCH) {
        // Ids are `{component}:{digest}`; a bare digest matches nothing.
        const ids = unique.slice(i, i + SOURCE_LOCATION_BATCH).map(digest => `${component.guid}:${digest}`).join(',');
        const url = new URL('/source_locations', WEB_URL);
        url.search = new URLSearchParams({ 'filter[id]': ids }).toString();
        const result = await this.#request<Partial<WireSourceLocationsResponse>>(url.href, this.#session!);
        if (!Array.isArray(result?.data)) throw new SkylightError('INVALID_SOURCE_LOCATIONS_RESPONSE');
        for (const record of result.data) {
          const { digest, name } = record?.attributes ?? {};
          if (typeof digest === 'string' && typeof name === 'string') names.set(digest, name);
        }
      }
      return names;
    });
  }

  /** One deploy by its Skylight id, e.g. a trace annotation's deploy ref. */
  async getDeploy({ id }: { id: string }): Promise<Deploy> {
    if (typeof id !== 'string' || !id) throw new SkylightError('INVALID_DEPLOY_ID');
    return this.#run(async () => {
      const result = await this.#request<{ data?: Deploy }>(`${WEB_URL}/deploys/${encodeURIComponent(id)}`, this.#session!);
      if (typeof result?.data?.attributes?.git_sha !== 'string') throw new SkylightError('INVALID_DEPLOY_RESPONSE');
      return result.data;
    });
  }

  /**
   * One Monday-to-Monday UTC week: endpoint stats from seven daily highlights and app stats from hourly trends,
   * fetched in parallel. Skylight keeps data back to the Monday six weeks before the current one; older weeks are
   * empty.
   */
  async getWeek({ componentId, start }: { componentId?: string | undefined; start: number }): Promise<WeekData> {
    const monday = weekStart(start);
    const [days, series] = await Promise.all([
      Promise.all(Array.from({ length: 7 }, (_, day) =>
        this.getEndpointHighlights({ componentId, timestamp: monday + day * DAY_SECONDS, duration: DAY_SECONDS }))),
      this.getLatencyTrends({ componentId, timestamp: monday, duration: WEEK_SECONDS, step: 3_600 }),
    ]);
    return { start: monday, end: monday + WEEK_SECONDS, app: aggregateAppSeries(series),
      endpoints: aggregateEndpointDays(days.map(day => day.endpoints)) };
  }
}
