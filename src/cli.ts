import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { SkylightClient } from './skylight-client.ts';
import { SkylightError, type SkylightErrorCode } from './errors.ts';
import {
  DEPLOY_WINDOW, ENDPOINT_SORT_KEYS, ENDPOINT_WINDOW, LIMIT, TREND_STEPS, TREND_WINDOW, isEndpointSortKey, isTrendStep,
  type EndpointSortKey, type TrendStep, type WindowStart,
} from './spec.ts';
import {
  buildTraceTree, condenseTraceTree, countTraceNodes, locateTraceTree, needsInstrumentation, timeBreakdown,
  traceSourceRefs, type LocatedTraceTreeNode, type TraceTreeNode,
} from './trace.ts';
import { digestHistogram, digestQuantile } from './digest.ts';
import { compareEndpoints, type EndpointChange } from './compare.ts';
import { githubCommitUrl, parseGithubRepo, terminalLink } from './github.ts';
import { WEEK_SECONDS, weekStart, weeklyReport, type WeekData, type WeeklyChange } from './weekly.ts';
import { rankEndpoints, type RankedEndpoint } from './rank.ts';
import type { Component, Deploy, EndpointHighlight, EndpointSummary, Inspection } from './types.ts';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const days = (seconds: number) => `${seconds / 86_400}d`;
const hours = (seconds: number) => `${seconds / 3_600}h`;

const HELP = `skylight-cli ${version} — unofficial, read-only CLI for Skylight (skylight.io)

Usage: skylight-cli <command> [options]

Commands:
  auth                 Check that SKYLIGHT_MCP_TOKEN works
  apps                 List apps and their components
  components           List components (guid, environment, name)
  endpoints            List endpoint metrics for a component
  endpoint <name>      Latency and inspections (e.g. N+1 queries) for one endpoint;
                       <name> may omit the <sk-segment> variant, or be a search term
                       that matches exactly one endpoint
  trace <name>         The endpoint's aggregated trace as a tree: when each event starts,
                       how long it takes, its self time and allocations, and how often it occurs
  trends               App-wide request count and latency over time
  deploys              List deploys for a component
  compare              Endpoints that got slower (or faster) across a deploy
  report               Weekly trends like Skylight's: vs last week, biggest slowdowns,
                       most improved, and frog boils (slow creep) over 6 weeks

Options:
  -c, --component <c>  Component guid, "environment/name", or unique name
                       (default: $SKYLIGHT_COMPONENT_ID, or the only component)
      --since <d>      Window length: 90s, 30m, 6h, 45d, or seconds
                       endpoints/endpoint/trace: default ${hours(ENDPOINT_WINDOW.default)}, max ${hours(ENDPOINT_WINDOW.max)}
                       trends: default ${days(TREND_WINDOW.default)}, max ${days(TREND_WINDOW.max)}
                       deploys: default ${days(DEPLOY_WINDOW.default)}, max ${days(DEPLOY_WINDOW.max)}
      --at <unix>      Window start in unix seconds (default: now minus --since)
  -n, --limit <n>      Maximum rows, ${LIMIT.min}-${LIMIT.max} (default ${LIMIT.default})
  -s, --search <q>     endpoints: filter by name; "users#index" matches UsersController#index
      --sort <key>     endpoints: ${ENDPOINT_SORT_KEYS.join(' | ')} (default: agony, like Skylight)
      --step <s>       trends: bucket size in seconds, ${TREND_STEPS.join(' | ')}
                       (default: 60 up to 2h, 600 up to 24h, else 3600)
      --full           trace: show every event (default folds pass-through middleware
                       and hides events in fewer than 1% of requests)
      --min-ms <n>     trace: hide events shorter than n ms on average
      --latency <r>    trace: only requests in a response-time range: a-b (ms),
                       fastest (quickest 30%), or slowest (above p95)
      --no-sources     trace: skip resolving file:line and gem names (saves requests)
      --deploy <ref>   compare: git sha or deploy id prefix (default: the latest deploy);
                       --since sets each side's window (default 2h, max 24h); the after
                       window starts 5 min into the deploy, past the rollout
      --baseline <b>   compare: before (the window before the deploy, default) or week
                       (the same hours 7 days earlier: no time-of-day or weekday effects)
      --min-requests <n>  compare: requests needed in both windows (default 20);
                       report: in each week (default 100)
      --week <date>    report: any date in the week (YYYY-MM-DD, UTC; default: last full week)
      --weeks <n>      report: weeks for frog boils, 3-6 (default 6; Skylight keeps about 7)
      --repo <o/n>     GitHub repo (owner/name or URL) for links: trace file:line and
                       compare commits link there (clickable in terminals that support it)
      --json           Print JSON instead of a table
  -h, --help           Show this help
  -v, --version        Show version

Environment:
  SKYLIGHT_MCP_TOKEN   Token from https://www.skylight.io/app/settings/mcp (required)
  SKYLIGHT_GITHUB_REPO Same as --repo
`;

const OPTIONS = {
  component: { type: 'string', short: 'c' },
  since: { type: 'string' },
  at: { type: 'string' },
  limit: { type: 'string', short: 'n' },
  search: { type: 'string', short: 's' },
  sort: { type: 'string' },
  step: { type: 'string' },
  full: { type: 'boolean' },
  'min-ms': { type: 'string' },
  latency: { type: 'string' },
  'no-sources': { type: 'boolean' },
  deploy: { type: 'string' },
  week: { type: 'string' },
  repo: { type: 'string' },
  baseline: { type: 'string' },
  weeks: { type: 'string' },
  'min-requests': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Options = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

class UsageError extends Error {}

// Client validation errors caused by bad flags, as opposed to API failures.
const INPUT_ERRORS = new Set<SkylightErrorCode>(['INVALID_DURATION', 'INVALID_TIMESTAMP', 'INVALID_LIMIT',
  'INVALID_SEARCH', 'INVALID_SORT', 'INVALID_STEP', 'INVALID_ENDPOINT', 'COMPONENT_SELECTION_REQUIRED', 'COMPONENT_NOT_FOUND']);

const UNIT_SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

function duration(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const match = /^(\d+)([smhd])?$/.exec(value);
  if (!match) throw new UsageError(`Invalid --since: ${value}`);
  return Number(match[1]) * UNIT_SECONDS[(match[2] ?? 's') as keyof typeof UNIT_SECONDS];
}

function integer(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`Invalid --${name}: ${value}`);
  return Number(value);
}

const windowStart = (value: string | undefined): WindowStart => integer('at', value) ?? 'recent';

function sortKey(value: string | undefined): EndpointSortKey | undefined {
  if (value === undefined || isEndpointSortKey(value)) return value;
  throw new UsageError(`Invalid --sort: ${value} (expected ${ENDPOINT_SORT_KEYS.join(', ')})`);
}

function trendStep(value: string | undefined): TrendStep | undefined {
  if (value === undefined) return undefined;
  const step = integer('step', value);
  if (isTrendStep(step)) return step;
  throw new UsageError(`Invalid --step: ${value} (expected ${TREND_STEPS.join(', ')})`);
}

/** Pins 'recent' to one timestamp so that several requests see the same window. */
const pinnedStart = (start: WindowStart, seconds: number) => start === 'recent' ? Math.floor(Date.now() / 1000) - seconds : start;

type Column<T> = [title: string, get: (row: T) => unknown];

function table<T>(rows: readonly T[], columns: Column<T>[]): string {
  if (!rows.length) return '(none)\n';
  const cells = rows.map(row => columns.map(([, get]) => String(get(row) ?? '')));
  const widths = columns.map(([title], i) => Math.max(title.length, ...cells.map(line => line[i]!.length)));
  const format = (line: string[]) => line.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd();
  return [format(columns.map(([title]) => title)), ...cells.map(format)].join('\n') + '\n';
}

async function resolveComponent(client: SkylightClient, selector: string | undefined): Promise<string | undefined> {
  if (selector === undefined) return undefined;
  const components = await client.listComponents();
  const wanted = selector.toLowerCase();
  const found = components.filter(c => c.guid === selector
    || `${c.environment}/${c.name}`.toLowerCase() === wanted || c.name?.toLowerCase() === wanted);
  if (found.length === 1) return found[0]!.guid;
  throw new UsageError(found.length ? `Component "${selector}" is ambiguous; use "environment/name" or a guid`
    : `Component "${selector}" not found; run \`skylight-cli components\``);
}

const indent = (text: string) => text.split('\n').map(line => (line ? `    ${line}` : line)).join('\n');

const time = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const minute = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
const oneLine = (text: string | null | undefined, max: number) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const range = (digest: { min: number; max: number; count: number }) =>
  digest.count ? (digest.min === digest.max ? `${digest.min}` : `${digest.min}–${digest.max}`) : '-';

function inspectionText(inspection: Inspection): string {
  const [category, title, detail] = inspection.event;
  const kind = inspection.type === 'nPlusOneQuery' ? 'N+1 query' : inspection.type;
  return `  ${kind}  severity ${inspection.severity}  ${category}${title ? `  ${title}` : ''}\n`
    + `    repeated ${range(inspection.repetitions)}× per request, duration ${range(inspection.durations)}\n`
    + (detail ? `    ${oneLine(detail, 300)}\n` : '');
}

interface Output { json: unknown; text: string }
/** Output context: the GitHub repo for links, and whether stdout is a terminal that can show hyperlinks. */
interface Context { repo: string | undefined; links: boolean }

type Command = (client: SkylightClient, options: Options, componentId: string | undefined, args: string[], context: Context) => Promise<Output>;

/** compare: the after window starts this long after a deploy starts, past the rollout. */
const DEPLOY_SETTLE_SECONDS = 300;

/** Positional arguments each command takes after its name. */
const ARGUMENTS: Record<string, string[]> = { endpoint: ['<name>'], trace: ['<name>'] };

/** Resolves a search term to one canonical endpoint (with its <sk-segment> tag), then fetches its summary. */
async function endpointSummary(client: SkylightClient, options: Options, componentId: string | undefined, query: string):
  Promise<{ highlight: EndpointHighlight; detail: EndpointSummary }> {
  const seconds = duration(options.since, ENDPOINT_WINDOW.default);
  // One pinned start, so the search and the summary cover the same window.
  const timestamp = pinnedStart(windowStart(options.at), seconds);
  const matches = await client.listEndpoints({ componentId, timestamp, duration: seconds, limit: LIMIT.max, search: query, sortBy: 'count' });
  // Prefer an exact name; then, ignoring the <sk-segment> variant, the one variant that is not `error`.
  const base = (name: string) => name.replace(/<sk-segment>.*<\/sk-segment>$/, '');
  const sameBase = matches.endpoints.filter(e => base(e.name) === query && !e.name.endsWith('<sk-segment>error</sk-segment>'));
  const highlight = matches.endpoints.find(e => e.name === query)
    ?? (sameBase.length === 1 ? sameBase[0] : undefined)
    ?? (matches.total === 1 ? matches.endpoints[0] : undefined);
  if (!highlight) {
    throw new UsageError(matches.total === 0 ? `No endpoint matching "${query}" had requests in this window`
      : `"${query}" matches ${matches.total} endpoints; use the full name:\n${matches.endpoints.slice(0, 10).map(e => `  ${e.name}`).join('\n')}`);
  }
  return { highlight, detail: await client.getEndpointDetail({ componentId, endpoint: highlight.name, timestamp, duration: seconds }) };
}

/** `a-b` in ms, or a preset resolved against the endpoint's latency digest once it is fetched. */
function latencyRange(value: string | undefined): [number, number] | 'fastest' | 'slowest' | undefined {
  if (value === undefined) return undefined;
  if (value === 'fastest' || value === 'slowest') return value;
  const match = /^(\d+)-(\d+)$/.exec(value);
  if (!match || Number(match[1]) >= Number(match[2])) {
    throw new UsageError(`Invalid --latency: ${value} (expected e.g. 100-500, fastest, or slowest)`);
  }
  return [Number(match[1]), Number(match[2])];
}

/** fastest: the quickest 30% of requests; slowest: the problem responses above p95 (as in the official MCP). */
function resolveLatency(range: ReturnType<typeof latencyRange>, detail: EndpointSummary): [number, number] | undefined {
  if (range === 'fastest') return [0, (digestQuantile(detail.endpoint.latencies, 0.3) ?? 0) + 1];
  if (range === 'slowest') return [digestQuantile(detail.endpoint.latencies, 0.95) ?? 0, Number.MAX_SAFE_INTEGER];
  return range;
}

const breakdownText = (tree: TraceTreeNode) =>
  Object.entries(timeBreakdown(tree)).map(([group, percent]) => `${group} ${percent}%`).join(' · ');

function histogramLines(detail: EndpointSummary): string[] {
  const buckets = digestHistogram(detail.endpoint.latencies);
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const peak = Math.max(...buckets.map(b => b.count), 1);
  const label = (b: { from: number; to: number }) => `${b.from}-${b.to - 1}`.padStart(11);
  return buckets.map(b => `${label(b)}  ${'█'.repeat(Math.round((b.count / peak) * 30)).padEnd(30)}  ${total ? ((b.count / total) * 100).toFixed(1) : '0.0'}%`);
}

const ms = (value: number) => value.toFixed(1);

/**
 * `app/x.rb:12 (+2)` for app code, `[gem]` when only gems are involved, nothing for synthetic events. With `links`,
 * file:line becomes a terminal hyperlink to GitHub.
 */
function sourceSuffix(node: TraceTreeNode | LocatedTraceTreeNode, links: boolean): string {
  if (!('locations' in node) || !node.locations.length) return '';
  const [first] = node.locations;
  const app = node.locations.filter(l => l.inApp);
  if (app.length) {
    const others = new Set(app.map(l => `${l.name}:${l.line}`)).size - 1;
    const text = `${first!.name ?? '(unknown source)'}:${first!.line}`;
    return `  ${links && first!.url ? terminalLink(text, first!.url) : text}${others ? ` (+${others})` : ''}`;
  }
  return first!.name ? `  [${first!.name}]` : '';
}

function traceLines(node: TraceTreeNode | LocatedTraceTreeNode, links = false, prefix = '', last = true, isRoot = true): string[] {
  const repeated = node.repetitions > 1 ? ` ×${node.repetitions < 10 ? node.repetitions.toFixed(1) : Math.round(node.repetitions)}` : '';
  const label = `${isRoot ? '' : `${prefix}${last ? '└─ ' : '├─ '}`}${node.title ?? node.category}${repeated}${sourceSuffix(node, links)}`;
  const row = [ms(node.startMs).padStart(7), ms(node.durationMs).padStart(7), ms(node.selfMs).padStart(7),
    Math.round(node.allocations).toLocaleString('en-US').padStart(9), `${Math.round(node.occurrence * 100)}%`.padStart(5), label].join('  ');
  const childPrefix = isRoot ? '' : `${prefix}${last ? '   ' : '│  '}`;
  return [row, ...node.children.flatMap((child, i) => traceLines(child, links, childPrefix, i === node.children.length - 1, false))];
}

const COMPONENT_COLUMNS: Column<Component>[] = [
  ['GUID', c => c.guid], ['ENVIRONMENT', c => c.environment], ['NAME', c => c.name], ['APP', c => c.appName]];

const ENDPOINT_COLUMNS: Column<RankedEndpoint>[] = [
  ['GRADE', e => e.grade], ['AGONY', e => '!'.repeat(e.agony) || '-'], ['RPM', e => e.rpm < 10 ? e.rpm.toFixed(2) : Math.round(e.rpm)],
  ['P50', e => e.latencyP50], ['P95', e => e.latencyP95], ['P99', e => e.latencyP99],
  ['FLAGS', e => [e.inspections?.nPlusOneQuery ? 'N+1' : '', e.highAllocations ? 'ALLOC' : ''].filter(Boolean).join(',')],
  ['ENDPOINT', e => e.name]];

const DEPLOY_COLUMNS: Column<Deploy>[] = [
  ['START', d => d.attributes?.start_at], ['DEPLOY', d => d.attributes?.deploy_id],
  ['SHA', d => d.attributes?.git_sha?.slice(0, 12)], ['DESCRIPTION', d => d.attributes?.description?.split('\n')[0]]];

const COMMANDS: Record<string, Command> = {
  async auth(client) {
    const components = await client.listComponents();
    return { json: { ok: true, components: components.length },
      text: `Authenticated; ${components.length} component(s) visible.\n` };
  },

  async apps(client) {
    const apps = await client.listApps();
    return { json: apps, text: table(apps.flatMap(app => app.components), [
      ['APP', c => c.appName], ['ENVIRONMENT', c => c.environment], ['COMPONENT', c => c.name], ['GUID', c => c.guid]]) };
  },

  async components(client) {
    const components = await client.listComponents();
    return { json: components, text: table(components, COMPONENT_COLUMNS) };
  },

  async endpoints(client, options, componentId) {
    const result = await client.listEndpoints({
      componentId, duration: duration(options.since, ENDPOINT_WINDOW.default),
      timestamp: windowStart(options.at), limit: integer('limit', options.limit) ?? LIMIT.default,
      search: options.search, sortBy: sortKey(options.sort) ?? 'agony',
    });
    const header = `Window ${time(result.timestamp)} + ${result.duration}s; showing ${result.endpoints.length} of ${result.total}\n`;
    return { json: result, text: header + table(result.endpoints, ENDPOINT_COLUMNS) };
  },

  async endpoint(client, options, componentId, [query]) {
    const { highlight, detail } = await endpointSummary(client, options, componentId, query!);
    const { endpoint, inspections } = detail;
    const tree = buildTraceTree(detail.trace);
    const text = `Endpoint     ${endpoint.name}\n`
      + `Window       ${time(endpoint.timestamp)} + ${endpoint.duration}s\n`
      + `Requests     ${endpoint.count}\n`
      + `Latency      p50 ${highlight.latencyP50}  p95 ${highlight.latencyP95}  p99 ${highlight.latencyP99}  (min ${endpoint.latencies.min}, max ${endpoint.latencies.max})\n`
      + (tree ? `Time         ${breakdownText(tree)}\n` : '')
      + `Inspections  ${inspections.results.length || 'none'}\n`
      + inspections.results.map(inspectionText).join('')
      + (endpoint.latencies.count ? `\nResponse times (p5-p99, ms)\n${histogramLines(detail).join('\n')}\n` : '');
    return { json: { ...detail, highlight }, text };
  },

  async trace(client, options, componentId, [query], { repo, links }) {
    const range = latencyRange(options.latency);
    const minMs = options['min-ms'] === undefined ? 0 : Number(options['min-ms']);
    if (!Number.isFinite(minMs) || minMs < 0) throw new UsageError(`Invalid --min-ms: ${options['min-ms']}`);
    const { detail } = await endpointSummary(client, options, componentId, query!);
    const bounds = resolveLatency(range, detail);
    const tree = buildTraceTree(detail.trace, bounds ? { targets: t => t.start + t.length > bounds[0] && t.start < bounds[1] } : {});
    if (!tree) {
      return { json: null, text: `Endpoint  ${detail.endpoint.name}\nNo trace samples${range ? ' in that latency range' : ''} for this window.\n` };
    }
    const shown = options.full ? condenseTraceTree(tree, { maxSelfMs: -1, minDurationMs: minMs })
      : condenseTraceTree(tree, { minDurationMs: minMs, minOccurrence: 0.01 });
    const hidden = countTraceNodes(tree) - countTraceNodes(shown);
    let result: TraceTreeNode | LocatedTraceTreeNode = shown;
    let sources = '';
    if (!options['no-sources']) {
      // Source names are a nicety: a failed lookup must not lose the trace.
      try {
        const { digests, deployRefs } = traceSourceRefs(shown);
        // A deploy that fails to load (e.g. deleted) only loses its git sha, not the file names.
        const [names, settled] = await Promise.all([client.getSourceLocations({ componentId, digests }),
          Promise.allSettled(deployRefs.map(id => client.getDeploy({ id }).then(d => [id, d.attributes.git_sha] as const)))]);
        const deploys = settled.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
        result = locateTraceTree(shown, names, new Map(deploys), repo);
        const shas = [...new Set(deploys.map(([, sha]) => sha.slice(0, 7)))];
        sources = shas.length ? `Source    deploy ${shas.join(', ')}; ${names.size} of ${digests.length} locations resolved\n` : '';
      } catch (error) {
        const reason = error instanceof SkylightError ? (error.status ? `HTTP ${error.status}` : error.code) : 'lookup failed';
        sources = `Source    unavailable (${reason}); --no-sources skips the lookup\n`;
      }
    }
    const text = `Endpoint  ${detail.endpoint.name}\n`
      + `Window    ${time(detail.endpoint.timestamp)} + ${detail.endpoint.duration}s; ${tree.samples} requests`
      + `${bounds ? ` at ${typeof range === 'string' ? `${range} (` : ''}${bounds[0]}-${bounds[1] === Number.MAX_SAFE_INTEGER ? '' : bounds[1]} ms${typeof range === 'string' ? ')' : ''}` : ''}\n`
      + `Time      ${breakdownText(tree)}\n`
      + needsInstrumentation(tree).map(n => `Hint      ${n.title ?? n.category} spends ${Math.round((n.selfMs * n.samples) / (tree.durationMs * tree.samples) * 100)}% of the request in its own code; custom instrumentation would show where\n`).join('')
      + sources
      + (hidden ? `Hidden    ${hidden} events (folded middleware${options.full ? '' : ', under 1% of requests'}${minMs ? `, under ${minMs} ms` : ''}); --full shows all\n` : '')
      + `\n  START      DUR     SELF     ALLOC   SEEN  EVENT (times in ms, averaged over requests that include the event)\n`
      + traceLines(result, links).join('\n') + '\n';
    return { json: result, text };
  },

  async trends(client, options, componentId) {
    const seconds = duration(options.since, TREND_WINDOW.default);
    const series = await client.getLatencyTrends({ componentId, timestamp: windowStart(options.at), duration: seconds, step: trendStep(options.step) });
    const rows = series.counts.map((count, i) => ({
      at: series.timestamp + i * series.step, count, p50: series.latenciesP50[i], p95: series.latenciesP95[i],
      p99: series.latenciesP99[i], max: series.latenciesMax[i],
    }));
    const total = series.counts.reduce((sum, count) => sum + count, 0);
    const header = `Window ${time(series.timestamp)} + ${series.duration}s, step ${series.step}s; ${total} requests\n`;
    return { json: series, text: header + table(rows, [['TIME (UTC)', r => minute(r.at)], ['COUNT', r => r.count],
      ['P50', r => r.p50], ['P95', r => r.p95], ['P99', r => r.p99], ['MAX', r => r.max]]) };
  },

  async compare(client, options, componentId, _args, { repo, links }) {
    const { data: deploys } = await client.listDeploys({ componentId, limit: LIMIT.max });
    const ref = options.deploy?.toLowerCase();
    const index = ref === undefined ? 0 : deploys.findIndex(d => d.attributes.git_sha?.toLowerCase().startsWith(ref)
      || d.attributes.deploy_id?.toLowerCase().startsWith(ref) || d.id === options.deploy);
    const deploy = deploys[index];
    if (!deploy) throw new UsageError(ref ? `No deploy matching "${options.deploy}" in the last 45 days` : 'No deploys in the last 45 days');
    const started = Math.floor(Date.parse(deploy.attributes.start_at) / 1000);
    // `end_at` is when that version stopped reporting (it is "now" for the live deploy), not when the rollout
    // finished. The after window starts a few minutes past `start_at` instead, skipping mixed old/new traffic.
    const settled = started + DEPLOY_SETTLE_SECONDS;
    const available = Math.floor((Date.now() / 1000 - settled) / 60) * 60;
    let seconds = Math.min(duration(options.since, 7_200), ENDPOINT_WINDOW.max);
    if (available < seconds) {
      if (available < 600) {
        throw new UsageError(`Deploy ${deploy.attributes.git_sha.slice(0, 7)} has ${Math.max(0, Math.round(available / 60))} min of data after it; wait for at least 10`);
      }
      seconds = available;
    }
    const minRequests = integer('min-requests', options['min-requests']) ?? 20;
    const baseline = options.baseline ?? 'before';
    if (baseline !== 'before' && baseline !== 'week') throw new UsageError(`Invalid --baseline: ${baseline} (before or week)`);
    // `week` compares the same hours seven days earlier, so time-of-day and weekday traffic patterns cancel out.
    const baselineStart = baseline === 'week' ? settled - WEEK_SECONDS : started - seconds;
    const retained = weekStart(Date.now() / 1000) - 6 * WEEK_SECONDS;
    if (baselineStart < retained) throw new UsageError(`The baseline window starts before ${time(retained)}, older than Skylight keeps`);
    // Full lists: a long window can hold over the 500 endpoints listEndpoints returns.
    const [beforeRaw, afterRaw] = await Promise.all([
      client.getEndpointHighlights({ componentId, timestamp: baselineStart, duration: seconds }),
      client.getEndpointHighlights({ componentId, timestamp: settled, duration: seconds }),
    ]);
    const before = { ...beforeRaw, endpoints: rankEndpoints(beforeRaw.endpoints, beforeRaw.duration) };
    const after = { ...afterRaw, endpoints: rankEndpoints(afterRaw.endpoints, afterRaw.duration) };
    const result = compareEndpoints(before.endpoints, after.endpoints, { minRequests });
    // The version that was live during a week-ago baseline: the latest deploy started before it.
    const baselineDeploy = baseline === 'week'
      ? deploys.find(d => Date.parse(d.attributes.start_at) / 1000 <= baselineStart) : undefined;
    // Everything deployed since the baseline shows up in a week-over-week comparison, not only this deploy.
    const deploysSince = baseline === 'week'
      ? deploys.filter(d => { const at = Date.parse(d.attributes.start_at) / 1000; return at > baselineStart && at <= started; }).length : 0;
    const limit = integer('limit', options.limit) ?? LIMIT.default;
    // Deploys are newest first: the one just before this index happened after it.
    const next = index > 0 ? deploys[index - 1] : undefined;
    const overlapping = next && Date.parse(next.attributes.start_at) / 1000 < after.timestamp + after.duration;
    const hhmm = (at: number) => minute(at).slice(11);
    const percent = (change: number | null) => (change === null ? '' : ` (${change >= 0 ? '+' : ''}${Math.round(change * 100)}%)`);
    const columns: Column<EndpointChange>[] = [
      ['MS/MIN', c => `${c.impactMsPerMinute >= 0 ? '+' : ''}${Math.round(c.impactMsPerMinute)}`],
      ['RPM', c => `${c.before.rpm.toFixed(1)}→${c.after.rpm.toFixed(1)}`],
      ['P50', c => `${c.before.latencyP50}→${c.after.latencyP50}${percent(c.p50Change)}`],
      ['P95', c => `${c.before.latencyP95}→${c.after.latencyP95}${percent(c.p95Change)}`],
      ['ENDPOINT', c => c.name]];
    const slower = result.changed.filter(c => c.impactMsPerMinute > 0).slice(0, limit);
    const faster = result.changed.filter(c => c.impactMsPerMinute < 0).reverse().slice(0, Math.min(5, limit));
    const sha = deploy.attributes.git_sha;
    const commit = repo && sha ? githubCommitUrl(repo, sha) : null;
    const text = `Deploy    ${links && commit ? terminalLink(sha.slice(0, 7), commit) : sha.slice(0, 7)} at ${time(started)}  ${oneLine(deploy.attributes.description, 70)}\n`
      + (commit && !links ? `Commit    ${commit}\n` : '')
      + (baseline === 'week'
        ? `Windows   baseline ${time(before.timestamp).slice(0, 16)}, after ${time(after.timestamp).slice(0, 16)} UTC (${Math.round(seconds / 60)} min each, same time a week apart)\n`
          + `Baseline  ran ${baselineDeploy ? `deploy ${baselineDeploy.attributes.git_sha.slice(0, 7)} from ${time(Date.parse(baselineDeploy.attributes.start_at) / 1000)}` : 'a deploy older than 45 days'}; `
          + `${deploysSince} deploy${deploysSince === 1 ? '' : 's'} since, all included in the comparison\n`
        : `Windows   before ${hhmm(before.timestamp)}-${hhmm(before.timestamp + before.duration)}, after ${hhmm(after.timestamp)}-${hhmm(after.timestamp + after.duration)} UTC (${Math.round(seconds / 60)} min each)\n`)
      + `Compared  ${result.changed.length} endpoints with at least ${minRequests} requests in both; `
      + `${result.appeared.length} appeared, ${result.disappeared.length} disappeared\n`
      + (overlapping ? `Note      the next deploy (${next.attributes.git_sha.slice(0, 7)} at ${time(Date.parse(next.attributes.start_at) / 1000)}) falls inside the after window\n` : '')
      + `\nSlower (request time added per minute)\n${table(slower, columns)}`
      + `\nFaster\n${table(faster, columns)}`
      + (result.appeared.length ? `\nAppeared  ${result.appeared.slice(0, 5).map(e => e.name).join(', ')}${result.appeared.length > 5 ? ', …' : ''}\n` : '');
    return { json: { deploy, commitUrl: commit, baseline, baselineDeploy: baselineDeploy ?? null, deploysSince,
      before: { timestamp: before.timestamp, duration: before.duration },
      after: { timestamp: after.timestamp, duration: after.duration }, minRequests, ...result }, text };
  },

  async report(client, options, componentId) {
    const date = options.week === undefined ? undefined : Date.parse(`${options.week}T00:00:00Z`);
    if (date !== undefined && !Number.isFinite(date)) throw new UsageError(`Invalid --week: ${options.week} (expected YYYY-MM-DD)`);
    const current = weekStart(Math.floor(Date.now() / 1000));
    const target = date === undefined ? current - WEEK_SECONDS : weekStart(date / 1000);
    if (target >= current) throw new UsageError('That week is not over yet; pick an earlier --week');
    const count = integer('weeks', options.weeks) ?? 6;
    if (count < 3 || count > 6) throw new UsageError(`Invalid --weeks: ${options.weeks} (3-6)`);
    // Weeks are fetched one at a time (8 requests each) to stay gentle on the API.
    const weeks: WeekData[] = [];
    for (let i = count - 1; i >= 0; i--) weeks.push(await client.getWeek({ componentId, start: target - i * WEEK_SECONDS }));
    // Weeks older than Skylight's retention come back empty: keep the contiguous weeks with data.
    const firstWithData = weeks.findIndex(w => w.endpoints.size > 0);
    const usable = firstWithData < 0 ? weeks.slice(-1) : weeks.slice(firstWithData);
    const report = weeklyReport(usable, { minRequests: integer('min-requests', options['min-requests']) ?? 100,
      limit: integer('limit', options.limit) ?? 5 });
    const day = (at: number) => new Date(at * 1000).toISOString().slice(0, 10);
    const pct = (change: number) => `${change >= 0 ? '+' : ''}${Math.round(change * 100)}%`;
    const millions = (n: number | null) => n === null ? '-' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n.toLocaleString('en-US');
    const columns: Column<WeeklyChange>[] = [
      ['MS/MIN', c => `${c.impactMsPerMinute >= 0 ? '+' : ''}${Math.round(c.impactMsPerMinute)}`],
      ['RPM', c => c.rpm.toFixed(1)], ['BEFORE', c => Math.round(c.before)], ['AFTER', c => Math.round(c.after)],
      ['CHANGE', c => pct(c.change)], ['ENDPOINT', c => c.name]];
    const blocks = report.reports.map(r => {
      const label = r.percentile === 50 ? 'Typical performance (p50)' : 'Problem performance (p95)';
      const headline = r.after === null ? 'no data'
        : `${Math.round(r.after)} ms, ${r.change === null ? 'no previous week to compare'
          : !r.changed ? 'no change from last week' : `${Math.abs(Math.round(r.change * 100))}% ${r.change < 0 ? 'faster' : 'slower'} than last week`}`;
      return `${label}: ${headline}\n`
        + `\n  Biggest slowdowns\n${indent(table(r.slowdowns, columns))}`
        + `\n  Most improved\n${indent(table(r.improved, columns))}`
        + `\n  Frog boils (slow creep over ${report.boilWeeks || usable.length} weeks)\n`
        + (report.boilWeeks ? indent(table(r.boils, [['CHANGE', c => pct(c.change)], ['RPM', c => c.rpm.toFixed(1)],
          ['WEEKLY', c => c.series.map(v => Math.round(v)).join(' → ')], ['ENDPOINT', c => c.name]]))
          : '    (needs at least 3 weeks of data)\n');
    });
    const text = `Week      ${day(report.start)} to ${day(report.end - 1)} (UTC, Monday to Sunday)\n`
      + `Requests  ${millions(report.requests.after)}${report.requests.before && report.requests.after ? ` (${pct(report.requests.after / report.requests.before - 1)} vs last week)` : ''}\n`
      + (usable.length < weeks.length ? `Note      only ${usable.length} of ${weeks.length} weeks have data (Skylight keeps about 7 weeks)\n` : '')
      + `Method    rebuilt from daily highlights; weekly values are request-weighted means, thresholds are ours\n\n`
      + blocks.join('\n');
    return { json: report, text };
  },

  async deploys(client, options, componentId) {
    const result = await client.listDeploys({
      componentId, duration: duration(options.since, DEPLOY_WINDOW.default),
      timestamp: windowStart(options.at), limit: integer('limit', options.limit) ?? LIMIT.default,
    });
    return { json: result, text: `Showing ${result.data.length} of ${result.total}\n` + table(result.data, DEPLOY_COLUMNS) };
  },
};

interface Writable { write(chunk: string): unknown; isTTY?: boolean }

export interface MainIO {
  env?: Record<string, string | undefined>;
  stdout?: Writable;
  stderr?: Writable;
  fetch?: typeof globalThis.fetch;
}

/** Returns the process exit code: 0 ok, 1 API failure, 2 usage error. */
export async function main(argv: string[], { env = process.env, stdout = process.stdout, stderr = process.stderr, fetch }: MainIO = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    stderr.write(`${(error as Error).message}\n\nRun \`skylight-cli --help\` for usage.\n`);
    return 2;
  }
  const { values: options, positionals } = parsed;
  if (options.version) { stdout.write(`${version}\n`); return 0; }
  const [command, ...extra] = positionals;
  if (options.help || !command) { (command || options.help ? stdout : stderr).write(HELP); return options.help ? 0 : 2; }
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!run) {
    stderr.write(`Unknown command: ${command}\n\nRun \`skylight-cli --help\` for usage.\n`);
    return 2;
  }
  const expected = ARGUMENTS[command] ?? [];
  if (extra.length !== expected.length) {
    stderr.write(`Usage: skylight-cli ${[command, ...expected].join(' ')} [options]\n`);
    return 2;
  }
  try {
    const repoValue = options.repo ?? (env.SKYLIGHT_GITHUB_REPO || undefined);
    const repo = parseGithubRepo(repoValue);
    if (repoValue !== undefined && !repo) throw new UsageError(`Invalid --repo: ${repoValue} (expected owner/name or a github.com URL)`);
    let client: SkylightClient;
    try {
      client = new SkylightClient({ token: env.SKYLIGHT_MCP_TOKEN, ...(fetch ? { fetch } : {}) });
    } catch {
      throw new UsageError('SKYLIGHT_MCP_TOKEN is not set; create one at https://www.skylight.io/app/settings/mcp');
    }
    const componentId = await resolveComponent(client, options.component ?? (env.SKYLIGHT_COMPONENT_ID || undefined));
    // Hyperlinks only for a terminal; pipes and --json get plain text (and URLs in the JSON).
    const output = await run(client, options, componentId, extra, { repo, links: Boolean(stdout.isTTY) && !options.json });
    stdout.write(options.json ? `${JSON.stringify(output.json, null, 2)}\n` : output.text);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`${error.message}\n`); return 2; }
    if (error instanceof SkylightError) {
      const hint = error.code === 'COMPONENT_SELECTION_REQUIRED' ? '; pass --component (see `skylight-cli components`)'
        : error.code === 'HTTP_ERROR' && (error.status === 401 || error.status === 403) ? '; check SKYLIGHT_MCP_TOKEN' : '';
      stderr.write(`${error.message}${hint}\n`);
      return INPUT_ERRORS.has(error.code) ? 2 : 1;
    }
    stderr.write('Unexpected error\n');
    return 1;
  }
}
