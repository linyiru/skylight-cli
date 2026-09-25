const WEB_URL = 'https://www.skylight.io';

export class SkylightError extends Error {
  constructor(code, status) {
    super(`Skylight request failed: ${code}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'SkylightError';
    this.code = code;
    this.status = status;
  }
}

function dataUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new SkylightError('INVALID_DATA_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || (url.port && url.port !== '443')
    || !(url.hostname === 'skylight.io' || url.hostname.endsWith('.skylight.io'))) {
    throw new SkylightError('INVALID_DATA_URL');
  }
  return url.href.replace(/\/$/, '');
}

function windowParams({ timestamp = 'recent', duration }, maxDuration) {
  if (!Number.isInteger(duration) || duration < 60 || duration > maxDuration || duration % 60) {
    throw new SkylightError('INVALID_DURATION');
  }
  if (timestamp === 'recent') timestamp = Math.floor(Date.now() / 1000) - duration;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new SkylightError('INVALID_TIMESTAMP');
  return { timestamp: Math.floor(timestamp / 60) * 60, duration };
}

function limitValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 500) throw new SkylightError('INVALID_LIMIT');
  return value;
}

const SORT_KEYS = { count: 'count', p50: 'latencyP50', p95: 'latencyP95', p99: 'latencyP99' };

// 'users#index' also matches 'UsersController#index' (Rails convention).
function endpointMatcher(search) {
  if (search === undefined) return () => true;
  if (typeof search !== 'string' || !search.trim()) throw new SkylightError('INVALID_SEARCH');
  const needle = search.trim().toLowerCase();
  const [controller, action] = needle.split('#');
  const railsName = action !== undefined && !controller.endsWith('controller')
    ? `${controller}controller#${action}` : undefined;
  return endpoint => {
    const name = String(endpoint?.name ?? '').toLowerCase();
    return name.includes(needle) || (railsName !== undefined
      && (name.startsWith(railsName) || name.includes(`::${railsName}`)));
  };
}

function sortEndpoints(endpoints, sortBy) {
  if (sortBy === undefined) return endpoints;
  const key = SORT_KEYS[sortBy];
  if (!key) throw new SkylightError('INVALID_SORT');
  return endpoints.toSorted((a, b) => (Number(b?.[key]) || 0) - (Number(a?.[key]) || 0));
}

function publicComponent(component, app) {
  return {
    guid: component.guid, name: component.name, environment: component.environment,
    slug: component.slug, appGuid: app.guid, appName: app.name,
  };
}

/** Read-only client for the HTTP endpoints observed in the official MCP. */
export class SkylightClient {
  #token;
  #fetch;
  #session;
  #dataUrl;
  #apps;
  #authPromise;

  constructor({ token = process.env.SKYLIGHT_MCP_TOKEN, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
      throw new SkylightError('MISSING_OR_INVALID_TOKEN');
    }
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  async #request(url, token, body) {
    let response;
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
      // Do not expose server error bodies or credentials via exception causes.
      await response.body?.cancel().catch(() => {});
      throw new SkylightError('HTTP_ERROR', response.status);
    }
    try { return await response.json(); } catch { throw new SkylightError('INVALID_JSON'); }
  }

  async #authenticate() {
    if (!this.#authPromise) {
      this.#authPromise = (async () => {
        const result = await this.#request(`${WEB_URL}/mcp/authenticate`, this.#token);
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

  async #run(operation) {
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

  async #loadApps(refresh = false) {
    if (!this.#apps || refresh) {
      const result = await this.#request(`${WEB_URL}/mcp/apps`, this.#session);
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

  async #component(componentId) {
    const apps = await this.#loadApps();
    const components = apps.flatMap(app => app.components);
    const selected = componentId === undefined
      ? (components.length === 1 ? components[0] : undefined)
      : components.find(component => component.guid === componentId);
    if (!selected) throw new SkylightError(componentId === undefined ? 'COMPONENT_SELECTION_REQUIRED' : 'COMPONENT_NOT_FOUND');
    return selected;
  }

  async listApps({ refresh = false } = {}) {
    return this.#run(async () => (await this.#loadApps(refresh)).map(app => ({
      guid: app.guid, name: app.name,
      components: app.components.map(component => publicComponent(component, app)),
    })));
  }

  async listComponents({ refresh = false } = {}) {
    return (await this.listApps({ refresh })).flatMap(app => app.components);
  }

  async listEndpoints({ componentId, timestamp = 'recent', duration = 21600, limit = 20, search, sortBy } = {}) {
    const window = windowParams({ timestamp, duration }, 86400);
    limitValue(limit);
    const matches = endpointMatcher(search);
    if (sortBy !== undefined && !SORT_KEYS[sortBy]) throw new SkylightError('INVALID_SORT');
    return this.#run(async () => {
      const component = await this.#component(componentId);
      const token = component.client_api_token?.token;
      if (typeof token !== 'string' || !token) throw new SkylightError('MISSING_COMPONENT_TOKEN');
      const result = await this.#request(
        `${this.#dataUrl}/apps/${encodeURIComponent(component.guid)}/endpoint_highlights`, token, window,
      );
      if (!Array.isArray(result?.endpoints)) throw new SkylightError('INVALID_ENDPOINTS_RESPONSE');
      const endpoints = sortEndpoints(result.endpoints.filter(matches), sortBy);
      return { timestamp: result.timestamp, duration: result.duration, total: endpoints.length,
        endpoints: endpoints.slice(0, limit) };
    });
  }

  async listDeploys({ componentId, timestamp = 'recent', duration = 3888000, limit = 20 } = {}) {
    const window = windowParams({ timestamp, duration }, 15552000);
    limitValue(limit);
    return this.#run(async () => {
      const component = await this.#component(componentId);
      const url = new URL('/deploys', WEB_URL);
      url.search = new URLSearchParams({ ...window, app_component_id: component.guid }).toString();
      const result = await this.#request(url.href, this.#session);
      if (!Array.isArray(result?.data)) throw new SkylightError('INVALID_DEPLOYS_RESPONSE');
      return { total: result.data.length, data: result.data.slice(0, limit), meta: result.meta };
    });
  }
}
