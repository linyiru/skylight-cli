import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';
import { json, recordingFetch } from './helpers.ts';

const ENDPOINTS = [
  { name: 'UsersController#index', count: 10, latencyP50: 5, latencyP95: 90, latencyP99: 120, inspections: {} },
  { name: 'Admin::UsersController#index', count: 3, latencyP50: 9, latencyP95: 300, latencyP99: 400, inspections: {} },
  { name: 'PostsController#show', count: 50, latencyP50: 2, latencyP95: 40, latencyP99: 60, inspections: { nPlusOneQuery: 1 } },
];

interface RunOptions { components?: [environment: string, name: string][]; env?: Record<string, string> }

function run(argv: string[], { components = [['production', 'web'], ['staging', 'web']], env = {} }: RunOptions = {}) {
  const { fetch, calls: requests } = recordingFetch(options => {
    const { target } = options;
    if (target.pathname === '/mcp/authenticate') return json({ session: { token: 's' }, data_url: 'https://data-v3.skylight.io' });
    if (target.pathname === '/mcp/apps') {
      return json({ apps: [{ guid: 'app', name: 'Example', components: components.map(([environment, name], i) => ({
        guid: `guid-${i}`, name, environment, client_api_token: { token: 'c' } })) }] });
    }
    if (target.pathname.endsWith('/endpoint_highlights')) return json({ ...JSON.parse(options.body!), endpoints: ENDPOINTS });
    if (target.pathname === '/deploys') {
      return json({ data: [{ id: '1', attributes: { start_at: '2026-09-01T00:00:00Z', deploy_id: 'd1', git_sha: 'abcdef1234567890', description: 'first\nmore' } }], meta: {} });
    }
    throw new Error('Unexpected test request');
  });
  let stdout = '', stderr = '';
  const io = { env: { SKYLIGHT_MCP_TOKEN: 'mcp', ...env }, fetch,
    stdout: { write: (s: string) => { stdout += s; } }, stderr: { write: (s: string) => { stderr += s; } } };
  return main(argv, io).then(code => ({ code, stdout, stderr, requests }));
}

test('selects a component by environment/name and filters with Rails search', async () => {
  const { code, stdout, requests } = await run(['endpoints', '-c', 'staging/web', '-s', 'users#index', '--sort', 'p95', '--json']);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.endpoints.map((e: { name: string }) => e.name), ['Admin::UsersController#index', 'UsersController#index']);
  assert.equal(result.total, 2);
  assert.equal(requests.find(r => r.method === 'POST')?.target.pathname, '/apps/guid-1/endpoint_highlights');
});

test('parses --since and --at into the upstream window', async () => {
  const { code, requests } = await run(['endpoints', '-c', 'guid-0', '--since', '30m', '--at', '1201']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(requests.find(r => r.method === 'POST')?.body ?? ''), { timestamp: 1200, duration: 1800 });
});

test('renders deploys as a table', async () => {
  const { code, stdout } = await run(['deploys'], { components: [['production', 'web']] });
  assert.equal(code, 0);
  assert.match(stdout, /abcdef123456 +first$/m);
  assert.doesNotMatch(stdout, /more/);
});

test('reports usage errors with exit code 2 before calling the API', async () => {
  for (const argv of [['nope'], ['endpoints', '--since', 'soon'], ['endpoints', '--bogus'], ['endpoints', '--sort', 'agony']]) {
    const { code, requests } = await run(argv);
    assert.equal(code, 2, argv.join(' '));
    if (argv[1] !== '--sort') assert.equal(requests.length, 0, argv.join(' '));
  }
  assert.equal((await run(['endpoints'])).code, 2); // two components, none selected
  assert.equal((await run(['auth'], { env: { SKYLIGHT_MCP_TOKEN: '' } })).code, 2);
});
