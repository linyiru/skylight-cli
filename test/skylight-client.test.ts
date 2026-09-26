import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { SkylightClient } from '../src/skylight-client.ts';
import { json, recordingFetch } from './helpers.ts';

function fixture({ expire = false, components = 1, origin = 'https://data-v3.skylight.io' } = {}) {
  let authentications = 0;
  let expired = false;
  const { fetch, calls } = recordingFetch(options => {
    const { target } = options;
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.accept, '*/*');
    if (target.pathname === '/mcp/authenticate') {
      assert.equal(options.headers.authorization, 'test-mcp-secret');
      authentications++;
      return json({ session: { token: `test-session-${authentications}` }, data_url: origin });
    }
    if (target.pathname === '/mcp/apps') {
      assert.equal(options.headers.authorization, `test-session-${authentications}`);
      return json({ apps: [{ guid: 'app', name: 'Example', components: Array.from({ length: components }, (_, i) => ({
        guid: `component-${i}`, name: 'web', environment: 'production',
        client_api_token: { token: `test-client-${authentications}`, expires: 9999999999 },
      })) }] });
    }
    if (target.pathname.endsWith('/endpoint_highlights')) {
      assert.equal(options.headers.authorization, `test-client-${authentications}`);
      assert.equal(target.origin, origin);
      if (expire && !expired) {
        expired = true;
        return new Response('secret error body', { status: 401 });
      }
      return json({ ...JSON.parse(options.body!), endpoints: [{ name: 'A' }, { name: 'B' }] });
    }
    if (target.pathname === '/deploys') {
      assert.equal(options.headers.authorization, `test-session-${authentications}`);
      assert.equal(target.searchParams.get('app_component_id'), 'component-0');
      return json({ data: [{ id: '1' }, { id: '2' }], meta: {} });
    }
    throw new Error('Unexpected test request');
  });
  return { client: new SkylightClient({ token: 'test-mcp-secret', fetch }), calls };
}

test('uses the three token types correctly and exposes no credentials in app metadata', async () => {
  const { client, calls } = fixture();
  const apps = await client.listApps();
  assert.equal(apps[0]?.components.length, 1);
  assert.doesNotMatch(JSON.stringify(apps) + inspect(client), /test-(mcp|session|client)|client_api_token/);
  const endpoints = await client.listEndpoints({ timestamp: 1201, duration: 600, limit: 1 });
  assert.deepEqual({ ...endpoints, endpoints: endpoints.endpoints.map(e => e.name) },
    { timestamp: 1200, duration: 600, total: 2, endpoints: ['A'] });
  const endpointCall = calls.find(call => call.method === 'POST')!;
  assert.deepEqual(JSON.parse(endpointCall.body!), { timestamp: 1200, duration: 600 });
  assert.equal(endpointCall.target.pathname, '/apps/component-0/endpoint_highlights');
  const deploys = await client.listDeploys({ timestamp: 1201, duration: 600, limit: 1 });
  assert.equal(deploys.total, 2);
  assert.equal(deploys.data.length, 1);
  const deployQuery = calls.at(-1)!.target.searchParams;
  assert.equal(deployQuery.get('timestamp'), '1200');
  assert.equal(deployQuery.get('duration'), '600');
});

test('refreshes both session and component credentials after a 401', async () => {
  const { client, calls } = fixture({ expire: true });
  assert.equal((await client.listEndpoints()).total, 2);
  assert.equal(calls.filter(call => call.target.pathname === '/mcp/authenticate').length, 2);
  assert.equal(calls.filter(call => call.target.pathname === '/mcp/apps').length, 2);
});

test('requires explicit component selection when multiple components exist', async () => {
  const { client, calls } = fixture({ components: 2 });
  await assert.rejects(client.listEndpoints(), { code: 'COMPONENT_SELECTION_REQUIRED' });
  assert.equal(calls.length, 2);
  assert.equal((await client.listEndpoints({ componentId: 'component-1' })).total, 2);
  await assert.rejects(client.listDeploys({ componentId: 'unknown' }), { code: 'COMPONENT_NOT_FOUND' });
});

test('rejects untrusted data origins before forwarding credentials', async () => {
  for (const origin of ['https://skylight.io.attacker.example', 'http://data-v3.skylight.io', 'https://user:password@data-v3.skylight.io', 'https://data-v3.skylight.io:444']) {
    const { client, calls } = fixture({ origin });
    await assert.rejects(client.listEndpoints(), { code: 'INVALID_DATA_URL' });
    assert.equal(calls.length, 1);
  }
});

test('validates input before making HTTP requests', async () => {
  const { client, calls } = fixture();
  for (const args of [{ duration: 0 }, { duration: 61 }, { timestamp: -1 }, { limit: 0 }]) {
    await assert.rejects(client.listEndpoints(args));
  }
  assert.equal(calls.length, 0);
  assert.throws(() => new SkylightClient({ token: 'bad\ntoken' }), { code: 'MISSING_OR_INVALID_TOKEN' });
});

test('errors omit credentials, response bodies, and underlying network messages', async () => {
  for (const fetch of [async () => new Response('test-mcp-secret', { status: 403 }), async () => { throw new Error('test-mcp-secret'); }]) {
    const client = new SkylightClient({ token: 'test-mcp-secret', fetch });
    await assert.rejects(client.listApps(), error => {
      assert.doesNotMatch(inspect(error), /test-mcp-secret/);
      return true;
    });
  }
});
