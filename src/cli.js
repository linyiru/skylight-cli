import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { SkylightClient, SkylightError } from './skylight-client.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `skylight-cli ${version} — unofficial, read-only CLI for Skylight (skylight.io)

Usage: skylight-cli <command> [options]

Commands:
  auth                 Check that SKYLIGHT_MCP_TOKEN works
  apps                 List apps and their components
  components           List components (guid, environment, name)
  endpoints            List endpoint metrics for a component
  deploys              List deploys for a component

Options:
  -c, --component <c>  Component guid, "environment/name", or unique name
                       (default: $SKYLIGHT_COMPONENT_ID, or the only component)
      --since <d>      Window length: 90s, 30m, 6h, 45d, or seconds
                       (endpoints: default 6h, max 24h; deploys: default 45d, max 180d)
      --at <unix>      Window start in unix seconds (default: now minus --since)
  -n, --limit <n>      Maximum rows, 1-500 (default 20)
  -s, --search <q>     endpoints: filter by name; "users#index" matches UsersController#index
      --sort <key>     endpoints: count | p50 | p95 | p99 (default: upstream order)
      --json           Print JSON instead of a table
  -h, --help           Show this help
  -v, --version        Show version

Environment:
  SKYLIGHT_MCP_TOKEN   Token from https://www.skylight.io/app/settings/mcp (required)
`;

const OPTIONS = {
  component: { type: 'string', short: 'c' },
  since: { type: 'string' },
  at: { type: 'string' },
  limit: { type: 'string', short: 'n' },
  search: { type: 'string', short: 's' },
  sort: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}

// Client validation errors caused by bad flags, as opposed to API failures.
const INPUT_ERRORS = new Set(['INVALID_DURATION', 'INVALID_TIMESTAMP', 'INVALID_LIMIT', 'INVALID_SEARCH', 'INVALID_SORT',
  'COMPONENT_SELECTION_REQUIRED', 'COMPONENT_NOT_FOUND']);

function duration(value, fallback) {
  if (value === undefined) return fallback;
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!match) throw new UsageError(`Invalid --since: ${value}`);
  return Number(match[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's'];
}

function integer(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`Invalid --${name}: ${value}`);
  return Number(value);
}

function table(rows, columns) {
  if (!rows.length) return '(none)\n';
  const cells = rows.map(row => columns.map(([, get]) => String(get(row) ?? '')));
  const widths = columns.map(([title], i) => Math.max(title.length, ...cells.map(line => line[i].length)));
  const format = line => line.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  return [format(columns.map(([title]) => title)), ...cells.map(format)].join('\n') + '\n';
}

async function resolveComponent(client, selector) {
  if (selector === undefined) return undefined;
  const components = await client.listComponents();
  const wanted = selector.toLowerCase();
  const found = components.filter(c => c.guid === selector
    || `${c.environment}/${c.name}`.toLowerCase() === wanted || c.name?.toLowerCase() === wanted);
  if (found.length === 1) return found[0].guid;
  throw new UsageError(found.length ? `Component "${selector}" is ambiguous; use "environment/name" or a guid`
    : `Component "${selector}" not found; run \`skylight-cli components\``);
}

const time = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

const COMMANDS = {
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
    return { json: components, text: table(components, [
      ['GUID', c => c.guid], ['ENVIRONMENT', c => c.environment], ['NAME', c => c.name], ['APP', c => c.appName]]) };
  },

  async endpoints(client, options, componentId) {
    const result = await client.listEndpoints({
      componentId, duration: duration(options.since, 21600), timestamp: integer('at', options.at, 'recent'),
      limit: integer('limit', options.limit, 20), search: options.search, sortBy: options.sort,
    });
    const header = `Window ${time(result.timestamp)} + ${result.duration}s; showing ${result.endpoints.length} of ${result.total}\n`;
    return { json: result, text: header + table(result.endpoints, [
      ['COUNT', e => e.count], ['P50', e => e.latencyP50], ['P95', e => e.latencyP95], ['P99', e => e.latencyP99],
      ['N+1', e => e.inspections?.nPlusOneQuery], ['ALLOC', e => e.inspections?.objectAllocations], ['ENDPOINT', e => e.name]]) };
  },

  async deploys(client, options, componentId) {
    const result = await client.listDeploys({
      componentId, duration: duration(options.since, 3888000), timestamp: integer('at', options.at, 'recent'),
      limit: integer('limit', options.limit, 20),
    });
    return { json: result, text: `Showing ${result.data.length} of ${result.total}\n` + table(result.data, [
      ['START', d => d.attributes?.start_at], ['DEPLOY', d => d.attributes?.deploy_id],
      ['SHA', d => d.attributes?.git_sha?.slice(0, 12)], ['DESCRIPTION', d => d.attributes?.description?.split('\n')[0]]]) };
  },
};

/** Returns the process exit code: 0 ok, 1 API failure, 2 usage error. */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, fetch } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    stderr.write(`${error.message}\n\nRun \`skylight-cli --help\` for usage.\n`);
    return 2;
  }
  const { values: options, positionals } = parsed;
  if (options.version) { stdout.write(`${version}\n`); return 0; }
  const [command, ...extra] = positionals;
  if (options.help || !command) { (command || options.help ? stdout : stderr).write(HELP); return options.help ? 0 : 2; }
  if (!Object.hasOwn(COMMANDS, command) || extra.length) {
    stderr.write(`Unknown command: ${positionals.join(' ')}\n\nRun \`skylight-cli --help\` for usage.\n`);
    return 2;
  }
  try {
    let client;
    try {
      client = new SkylightClient({ token: env.SKYLIGHT_MCP_TOKEN, ...(fetch ? { fetch } : {}) });
    } catch {
      throw new UsageError('SKYLIGHT_MCP_TOKEN is not set; create one at https://www.skylight.io/app/settings/mcp');
    }
    const componentId = await resolveComponent(client, options.component ?? (env.SKYLIGHT_COMPONENT_ID || undefined));
    const output = await COMMANDS[command](client, options, componentId);
    stdout.write(options.json ? `${JSON.stringify(output.json, null, 2)}\n` : output.text);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`${error.message}\n`); return 2; }
    if (error instanceof SkylightError) {
      const hint = { COMPONENT_SELECTION_REQUIRED: '; pass --component (see `skylight-cli components`)',
        HTTP_ERROR: error.status === 401 || error.status === 403 ? '; check SKYLIGHT_MCP_TOKEN' : '' }[error.code] ?? '';
      stderr.write(`${error.message}${hint}\n`);
      return INPUT_ERRORS.has(error.code) ? 2 : 1;
    }
    stderr.write('Unexpected error\n');
    return 1;
  }
}
