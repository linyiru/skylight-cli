import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CachedCredentials, CredentialCache } from './skylight-client.ts';

/**
 * Credentials cached as one JSON file per MCP token (named by a hash, never the token) in a directory only the user
 * can read: 0700 for the directory, 0600 for files, written to a temporary file first and renamed into place.
 */
export function fileCredentialCache(directory: string): CredentialCache {
  const file = (key: string) => join(directory, `credentials-${key.replace(/[^a-f0-9]/gi, '')}.json`);
  return {
    async read(key) {
      try {
        return JSON.parse(await readFile(file(key), 'utf8')) as CachedCredentials;
      } catch {
        return undefined;
      }
    },
    async write(key, value) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const target = file(key);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await rename(temporary, target);
    },
    async clear(key) {
      await rm(file(key), { force: true });
    },
  };
}

/**
 * `$XDG_CACHE_HOME/skylight-cli`, else `$HOME/.cache/skylight-cli`; undefined when neither is set, so callers
 * without a home (e.g. tests with a bare environment) do not cache.
 */
export function defaultCacheDirectory(env: Record<string, string | undefined>): string | undefined {
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'skylight-cli');
  return env.HOME ? join(env.HOME, '.cache', 'skylight-cli') : undefined;
}
