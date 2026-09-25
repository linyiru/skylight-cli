/**
 * Turns live recordings into committable fixtures. Default-deny: every string is replaced with a keyed
 * pseudonym unless its key is on the safe list below. Statuses, error text, and timestamps are kept, because
 * they are what the fixtures exist to preserve.
 *
 * Traffic and latency must not reveal which parts of the app are busy or slow: request counts and latencies are
 * scaled by secret factors (volume 0.05-0.25, latency 0.35-0.70), and every identifier in an endpoint name,
 * including the action, is renamed. Trace tuples are not decoded yet, so their numbers are zeroed.
 *
 * Pseudonyms and factors derive from a local HMAC key (.fixture-key, gitignored): stable across re-recordings
 * on one machine, so fixture diffs stay small, and not reversible without the key.
 */
import { createHmac } from 'node:crypto';
import type { LiveContext, Recording } from './scenarios.ts';

/**
 * Array caps by `parent.key` (or bare key); the fixtures document shape, not volume. Only arrays the client
 * does not compute over are capped: q-digest nodes and trend series must stay complete.
 */
const ARRAY_LIMITS: Record<string, number> = { endpoints: 8, data: 5, 'trace.nodes': 12, 'trace.targets': 3 };

const SAFE_ENVIRONMENTS = new Set(['production', 'staging', 'development', 'test']);
const SAFE_COMPONENT_NAMES = new Set(['web', 'worker']);
/** Endpoint-name structure: namespaces and actions are renamed, formats and markers are not. */
const ENDPOINT_WORDS = new Set(['graphql', 'sk', 'segment', 'json', 'html', 'xml', 'csv', 'js', 'text', 'Controller']);
const SQL_WORDS = new Set(['SELECT', 'FROM', 'INSERT', 'INTO', 'UPDATE', 'DELETE', 'WHERE', 'JOIN', 'AND', 'OR', 'IN']);
const SAFE_WORDS = new Set([...ENDPOINT_WORDS, ...SQL_WORDS]);

/** Numeric fields by what they measure (array items are matched without their `[]` suffix). */
const VOLUME_KEYS = new Set(['count', 'counts', 'objectAllocations']);
const LATENCY_KEYS = new Set(['latencyP50', 'latencyP95', 'latencyP99', 'latenciesP50', 'latenciesP90', 'latenciesP95',
  'latenciesP98', 'latenciesP99', 'latenciesMax']);
/** Q-digests whose values are latencies; `repetitions` counts queries per request and keeps its values. */
const LATENCY_DIGESTS = new Set(['latencies', 'durations']);

type Digest = { count: number; min: number; max: number; nodes: [number, number, number][] };
const isDigest = (value: object): value is Digest =>
  'nodes' in value && 'count' in value && 'min' in value && 'max' in value && Array.isArray((value as Digest).nodes);
/** Made-up endpoint names used by the scenarios themselves; not account data. */
export const PROBE_ENDPOINT_PREFIX = 'FixtureProbe';

/** Skylight event categories such as `db.sql.query` or `app.controller.request`. */
const CATEGORY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export class Sanitizer {
  readonly #key: Buffer;
  readonly #volume: number;
  readonly #latency: number;
  readonly #fixed = new Map<string, string>();
  #clientTokens = 0;
  /** Every original value replaced, with what kind of value it was, for the leak check. */
  readonly originals = new Map<string, string>();

  constructor(key: Buffer, ctx: LiveContext) {
    this.#key = key;
    const unit = (label: string) => createHmac('sha256', key).update(label).digest().readUInt32BE(0) / 2 ** 32;
    this.#volume = 0.05 + 0.2 * unit('scale:volume');
    this.#latency = 0.35 + 0.35 * unit('scale:latency');
    this.#remember(ctx.mcpToken, 'test-mcp-token');
    this.#remember(ctx.session, 'test-session-token');
    this.#remember(ctx.clientToken, 'test-client-token');
  }

  #remember(original: string, replacement: string, kind = 'fixed') {
    if (!original) return;
    this.#fixed.set(original, replacement);
    this.originals.set(original, kind);
  }

  #hash(value: string, length: number): string {
    return createHmac('sha256', this.#key).update(value).digest('hex').slice(0, length);
  }

  /** Same shape as Skylight's 12-character base62 guids. */
  id(value: string): string {
    if (!this.#fixed.has(value)) this.#remember(value, `fx${this.#hash(`id:${value}`, 10)}`, 'id');
    return this.#fixed.get(value)!;
  }

  #word(value: string): string {
    this.originals.set(value, 'identifier');
    const pseudo = `res${this.#hash(`w:${value}`, 5)}`;
    return /^[A-Z]/.test(value) ? pseudo[0]!.toUpperCase() + pseudo.slice(1) : pseudo;
  }

  #text(value: string, label: string): string {
    this.originals.set(value, label);
    return `${label}-${this.#hash(`t:${value}`, 8)}`;
  }

  /** Keeps Rails/GraphQL structure (`::`, `#`, `<sk-segment>`, formats); renames namespaces, controllers, actions. */
  endpoint(name: string): string {
    if (name.startsWith(PROBE_ENDPOINT_PREFIX)) return name;
    if (this.#fixed.has(name)) return this.#fixed.get(name)!;
    const pseudo = name.replace(/<\/?sk-segment>|[A-Za-z_][A-Za-z0-9_]*/g, token => {
      if (token.startsWith('<') || ENDPOINT_WORDS.has(token)) return token;
      if (token.endsWith('Controller')) return `${this.#word(token.slice(0, -'Controller'.length))}Controller`;
      return this.#word(token);
    });
    this.#remember(name, pseudo, 'endpoint');
    return pseudo;
  }

  #sql(title: string): string {
    return title.replace(/[A-Za-z_][A-Za-z0-9_]*/g, token => (SQL_WORDS.has(token) ? token : this.#word(token)));
  }

  /** At least 1 for any non-zero count, so "had traffic" survives scaling. */
  #scaleVolume(value: number): number {
    return value > 0 ? Math.max(1, Math.round(value * this.#volume)) : value;
  }

  #scaleLatency(value: number): number {
    return Math.max(0, Math.round(value * this.#latency));
  }

  #number(value: number, key: string, path: string[]): number {
    // Inside trace tuples (not trace.count/timestamp/duration).
    if (path[0] === 'trace' && path.length > 2) return 0;
    const base = key.replace(/\[\]$/, '');
    if (VOLUME_KEYS.has(base)) return this.#scaleVolume(value);
    if (LATENCY_KEYS.has(base)) return this.#scaleLatency(value);
    return value;
  }

  /**
   * Scales a q-digest while keeping it valid: each node's range is scaled, then widened to the smallest aligned
   * `[lower, lower + 2^level)` that covers it; coinciding nodes merge, and `count` stays the sum of node counts.
   */
  #digest(digest: Digest, scalesValues: boolean): Digest {
    const factor = scalesValues ? this.#latency : 1;
    const merged = new Map<string, [number, number, number]>();
    for (const [lower, level, count] of digest.nodes) {
      const start = Math.floor(lower * factor);
      const end = Math.max(start, Math.floor((lower + 2 ** level - 1) * factor));
      let scaledLevel = 0;
      while (Math.floor(start / 2 ** scaledLevel) * 2 ** scaledLevel + 2 ** scaledLevel - 1 < end) scaledLevel++;
      const aligned = Math.floor(start / 2 ** scaledLevel) * 2 ** scaledLevel;
      const node = merged.get(`${aligned}:${scaledLevel}`) ?? [aligned, scaledLevel, 0];
      node[2] += this.#scaleVolume(count);
      merged.set(`${aligned}:${scaledLevel}`, node);
    }
    const nodes = [...merged.values()];
    const min = Math.floor(digest.min * factor);
    return { ...digest, count: nodes.reduce((sum, [, , count]) => sum + count, 0), min,
      max: Math.max(min, Math.floor(digest.max * factor)), nodes };
  }

  #hex(value: string): string {
    this.originals.set(value, 'hex');
    return this.#hash(`h:${value}`, value.length).padEnd(value.length, '0');
  }

  #value(value: unknown, key: string, path: string[]): unknown {
    if (Array.isArray(value)) {
      const limit = ARRAY_LIMITS[path.slice(-2).join('.')] ?? ARRAY_LIMITS[path.at(-1) ?? ''];
      const kept = limit === undefined ? value : value.slice(0, limit);
      // Inspection events are positional: [category, title, sql].
      if (key === 'event') {
        return kept.map((item, i) => typeof item !== 'string' ? item
          : i === 0 && CATEGORY.test(item) ? item : i === 1 ? this.#sql(item) : this.#text(item, 'sql'));
      }
      // Items get a distinct key so nested arrays are not capped again.
      return kept.map(item => this.#value(item, `${key}[]`, [...path, '[]']));
    }
    if (value && typeof value === 'object') {
      if (isDigest(value)) return this.#digest(value, LATENCY_DIGESTS.has(key));
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.#value(v, k, [...path, k])]));
    }
    if (typeof value === 'number') return this.#number(value, key, path);
    if (typeof value !== 'string') return value;
    if (this.#fixed.has(value)) return this.#fixed.get(value);
    switch (key) {
      // Skylight issues a fresh session token per authenticate and fresh client tokens per /mcp/apps call,
      // so map by role rather than by value: replay handlers expect these exact names.
      case 'token':
        if (path.includes('session')) { this.#remember(value, 'test-session-token', 'token'); return 'test-session-token'; }
        if (path.includes('client_api_token')) {
          const replacement = this.#clientTokens++ ? `test-client-token-${this.#clientTokens}` : 'test-client-token';
          this.#remember(value, replacement, 'token');
          return replacement;
        }
        return this.#text(value, 'test-token');
      case 'guid': case 'id': return this.id(value);
      case 'type': case 'start_at': case 'end_at': return value;
      // Upstream error text (e.g. {"error": {"reason", "message"}}) is what fixtures exist to preserve.
      case 'message': case 'reason': return path.includes('error') ? this.#message(value) : this.#text(value, 'str');
      case 'data_url': return /^https:\/\/([a-z0-9-]+\.)*skylight\.io\/?$/.test(value) ? value : 'https://data-v3.skylight.io';
      case 'environment': return SAFE_ENVIRONMENTS.has(value) ? value : this.#text(value, 'env');
      case 'deploy_id': case 'git_sha': return /^[0-9a-f]+$/i.test(value) ? this.#hex(value) : this.#text(value, 'deploy');
      case 'description': return this.#text(value, 'description');
      case 'name':
        if (path.includes('components') && SAFE_COMPONENT_NAMES.has(value)) return value;
        if (path.includes('endpoints') || path.includes('endpoint')) return this.endpoint(value);
        return this.#text(value, 'name');
      default: return CATEGORY.test(value) ? value : this.#text(value, 'str');
    }
  }

  /**
   * Replaces ids and endpoint names in place, keeping the URL's original encoding: a scenario may deliberately
   * send an unencoded name, and the fixture must show what was actually sent.
   */
  #url(url: string): string {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/');
    const app = parts[parts.indexOf('apps') + 1];
    if (parts.includes('apps') && app) this.id(decodeURIComponent(app));
    if (parts.includes('endpoints')) this.endpoint(decodeURIComponent(parts.slice(parts.indexOf('endpoints') + 1, -1).join('/')));
    const component = parsed.searchParams.get('app_component_id');
    if (component) this.id(component);
    let out = url;
    for (const [original, replacement] of [...this.#fixed].sort((a, b) => b[0].length - a[0].length)) {
      for (const form of [encodeURIComponent, (v: string) => v.replaceAll('#', '%23'), (v: string) => v]) {
        out = out.split(form(original)).join(form(replacement));
      }
    }
    return out;
  }

  /** Error bodies are upstream messages; keep them but scrub any original value that leaked into them. */
  #message(text: string): string {
    let out = text;
    for (const [original, replacement] of [...this.#fixed].sort((a, b) => b[0].length - a[0].length)) {
      out = out.split(original).join(replacement);
    }
    return out;
  }

  recording(recording: Recording): Recording {
    // Request bodies are our own parameters (timestamps, ranges) and are kept. Structured responses go first,
    // so names they introduce are known when scrubbing URLs and messages.
    const request = recording.request;
    const { body } = recording.response;
    // HTML error pages are generic site chrome that tests never inspect; keep only a marker.
    const responseBody = typeof body === 'string' && body.startsWith('<!DOCTYPE')
      ? `<!DOCTYPE html><!-- Skylight HTML error page (${body.length} bytes) omitted from fixture -->`
      : typeof body === 'string' ? this.#message(body) : this.#value(body, '', []);
    return {
      ...recording,
      request: { ...request, url: this.#url(request.url) },
      response: { ...recording.response, body: responseBody },
    };
  }

  /** Originals that still appear in the serialized text; must be empty before writing. */
  leaks(serialized: string): { value: string; kind: string }[] {
    return [...this.originals]
      .filter(([original]) => original.length >= 6 && !SAFE_WORDS.has(original) && serialized.includes(original))
      .map(([value, kind]) => ({ value, kind }));
  }
}
