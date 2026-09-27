import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkylightClient, type CachedCredentials, type CredentialCache } from '../src/skylight-client.ts';
import { defaultCacheDirectory, fileCredentialCache } from '../src/cache.ts';
import { json, recordingFetch } from './helpers.ts';

const now = () => Math.floor(Date.now() / 1000);

function upstream({ unauthorizedOnce = false } = {}) {
  let sessions = 0, rejected = false;
  return recordingFetch(({ target, headers }) => {
    if (target.pathname === '/mcp/authenticate') {
      sessions++;
      return json({ session: { token: `session-${sessions}`, refresh_ts: now() + 4_500, expiry_ts: now() + 10_800 },
        data_url: 'https://data-v3.skylight.io' });
    }
    if (target.pathname === '/mcp/apps') {
      return json({ apps: [{ guid: 'app', name: 'A', components: [{ guid: 'web', name: 'web', environment: 'production',
        client_api_token: { token: `client-${sessions}`, expires: now() + 3_600 } }] }] });
    }
    if (target.pathname === '/deploys') {
      if (unauthorizedOnce && !rejected && headers.authorization === 'session-cached') {
        rejected = true;
        return new Response('', { status: 401 });
      }
      return json({ data: [], meta: {} });
    }
    throw new Error(`unexpected ${target.pathname}`);
  });
}

function memoryCache(initial?: CachedCredentials) {
  const store = new Map<string, CachedCredentials>();
  const keys: string[] = [];
  const cache: CredentialCache = {
    read: key => { keys.push(key); return store.get(key) ?? (initial && !store.size ? initial : undefined); },
    write: (key, value) => { store.set(key, value); },
    clear: key => { store.delete(key); initial = undefined; },
  };
  return { cache, store, keys };
}

test('a second client reuses the cached session and apps: one request instead of three', async () => {
  const { cache, store, keys } = memoryCache();
  const first = upstream();
  await new SkylightClient({ token: 'mcp-secret', fetch: first.fetch, cache }).listDeploys();
  assert.deepEqual(first.calls.map(c => c.target.pathname), ['/mcp/authenticate', '/mcp/apps', '/deploys']);
  const second = upstream();
  await new SkylightClient({ token: 'mcp-secret', fetch: second.fetch, cache }).listDeploys();
  assert.deepEqual(second.calls.map(c => c.target.pathname), ['/deploys']);
  assert.equal(second.calls[0]!.headers.authorization, 'session-1');
  // The key identifies the token without containing it, and nothing cached does either.
  assert.ok(keys.every(k => /^[0-9a-f]{32}$/.test(k)));
  assert.doesNotMatch(JSON.stringify([...store.values()]), /mcp-secret/);
});

test('expired sessions are renewed; a 401 on a cached session clears it and authenticates fresh', async () => {
  const expired = memoryCache({ session: 'session-old', dataUrl: 'https://data-v3.skylight.io', expiresAt: now() + 30 });
  const renewed = upstream();
  await new SkylightClient({ token: 't', fetch: renewed.fetch, cache: expired.cache }).listDeploys();
  assert.equal(renewed.calls[0]!.target.pathname, '/mcp/authenticate');

  const revoked = memoryCache({ session: 'session-cached', dataUrl: 'https://data-v3.skylight.io', expiresAt: now() + 3_600,
    apps: [{ guid: 'app', name: 'A', components: [{ guid: 'web', name: 'web', environment: 'production', slug: 'w' }] }],
    appsExpireAt: now() + 3_600 });
  const retried = upstream({ unauthorizedOnce: true });
  await new SkylightClient({ token: 't', fetch: retried.fetch, cache: revoked.cache }).listDeploys();
  assert.deepEqual(retried.calls.map(c => c.target.pathname), ['/deploys', '/mcp/authenticate', '/mcp/apps', '/deploys']);
  assert.equal([...revoked.store.values()][0]!.session, 'session-1');
});

test('a cached data URL must pass the same origin check; a broken cache is ignored', async () => {
  const tampered = memoryCache({ session: 's', dataUrl: 'https://skylight.io.attacker.example', expiresAt: now() + 3_600 });
  const fresh = upstream();
  await new SkylightClient({ token: 't', fetch: fresh.fetch, cache: tampered.cache }).listDeploys();
  assert.equal(fresh.calls[0]!.target.pathname, '/mcp/authenticate');
  const broken: CredentialCache = { read: () => { throw new Error('disk'); }, write: () => { throw new Error('disk'); }, clear: () => {} };
  await new SkylightClient({ token: 't', fetch: upstream().fetch, cache: broken }).listDeploys();
});

test('file cache: 0700 directory, 0600 file, round trip, clear', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'skylight-cli-')), 'nested', 'skylight-cli');
  const cache = fileCredentialCache(directory);
  const value: CachedCredentials = { session: 's', dataUrl: 'https://data-v3.skylight.io', expiresAt: 1 };
  assert.equal(await cache.read('abc'), undefined);
  await cache.write('abc', value);
  assert.deepEqual(await cache.read('abc'), value);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const [file] = await readdir(directory);
  assert.equal((await stat(join(directory, file!))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(directory, file!), 'utf8')).session, 's');
  await cache.clear('abc');
  assert.equal(await cache.read('abc'), undefined);
  assert.equal(defaultCacheDirectory({ XDG_CACHE_HOME: '/x' }), '/x/skylight-cli');
  assert.equal(defaultCacheDirectory({ HOME: '/h' }), '/h/.cache/skylight-cli');
  assert.equal(defaultCacheDirectory({}), undefined);
});
