/**
 * Contract check against the live API: every recorded scenario must still produce the same status, media type,
 * JSON shape, and error text, and the client must still parse every happy-path response. Opt-in only:
 *
 *   SKYLIGHT_MCP_TOKEN=... npm run test:live
 *
 * A failure here means Skylight changed; re-record with `npm run fixtures:record` and review the diff.
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SkylightClient } from '../src/skylight-client.ts';
import { SCENARIOS, discover, runScenario, type LiveContext } from './support/scenarios.ts';
import { fixture } from './support/msw.ts';

const enabled = process.env.SKYLIGHT_LIVE === '1' && !!process.env.SKYLIGHT_MCP_TOKEN;

/**
 * Asserts the live value has the recorded structure: same value types (null matches anything, since fields such
 * as deploy descriptions are optional), every recorded key present (new keys are fine), arrays compared by their
 * first items.
 */
function assertShape(live: unknown, recorded: unknown, path = 'body'): void {
  if (live === null || recorded === null) return;
  if (Array.isArray(recorded)) {
    assert.ok(Array.isArray(live), `${path}: expected an array`);
    if (live.length && recorded.length) assertShape(live[0], recorded[0], `${path}[0]`);
    return;
  }
  if (typeof recorded === 'object') {
    assert.ok(live && typeof live === 'object' && !Array.isArray(live), `${path}: expected an object`);
    for (const [key, value] of Object.entries(recorded)) {
      assert.ok(key in live, `${path}.${key}: missing`);
      assertShape((live as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  assert.equal(typeof live, typeof recorded, `${path}: type`);
}

const errorOf = (body: unknown) => (body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined);
const withoutColumn = (text: unknown) => String(text).replace(/column \d+/, 'column N');

const mediaType = (value: string | null) => value?.split(';')[0]?.trim() ?? null;

describe('live contract', { skip: !enabled && 'set SKYLIGHT_LIVE=1 and SKYLIGHT_MCP_TOKEN (npm run test:live)' }, () => {
  let ctx: LiveContext;
  before(async () => { ctx = await discover(process.env.SKYLIGHT_MCP_TOKEN!); });

  for (const scenario of SCENARIOS) {
    test(scenario.name, async t => {
      const live = await runScenario(scenario, ctx);
      if (!live) return t.skip('no data for this scenario in this account right now');
      const recorded = fixture(scenario.name).response;
      assert.equal(live.response.status, recorded.status, 'status');
      assert.equal(mediaType(live.response.contentType), mediaType(recorded.contentType), 'media type');
      const { body } = live.response;
      if (typeof recorded.body === 'string') {
        // Upstream validation text (e.g. serde messages) is part of the contract; HTML error pages are not.
        if (!recorded.body.startsWith('<!DOCTYPE')) assert.equal(withoutColumn(body), withoutColumn(recorded.body), 'error text');
      } else if (errorOf(recorded.body)) {
        assert.deepEqual(errorOf(body), errorOf(recorded.body), 'error body');
      } else {
        assertShape(body, recorded.body);
      }
    });
  }

  test('client parses every happy-path response', async () => {
    const client = new SkylightClient();
    const [component] = await client.listComponents();
    const componentId = component!.guid;
    const endpoints = await client.listEndpoints({ componentId, sortBy: 'count', limit: 1 });
    await client.listDeploys({ componentId, limit: 1 });
    const trends = await client.getLatencyTrends({ componentId, duration: 8 * 86_400 });
    assert.equal(trends.counts.length, 8 * 24);
    const name = endpoints.endpoints[0]?.name;
    if (name) assert.equal((await client.getEndpointDetail({ componentId, endpoint: name })).endpoint.name, name);
  });
});
