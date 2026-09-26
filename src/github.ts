/**
 * GitHub links as Skylight's UI builds them (direwolf `models/deploy`): tree/{sha}/{path}#L{line} and commit/{sha}.
 * Skylight knows the app's repo, but only behind a web login (/apps/{id} answers 401 to an MCP session), so the
 * repo is passed in.
 *
 * Skylight's source paths are relative to the app's root. In a monorepo that root is a subdirectory (e.g.
 * `apps/rails`), which Skylight's own links leave out; a `root` here adds it back.
 */

export interface GithubLocation {
  /** `owner/name`. */
  repo: string;
  /** The app's directory within the repo, without leading or trailing slashes; '' at the repo root. */
  root: string;
}

const PREFIX = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?/;

/**
 * Parses `owner/name`, optionally followed by the app's directory (`owner/name/apps/rails`), or the same as a
 * github.com address: with or without http(s):// or www., a browser URL such as `…/tree/develop/apps/rails` (the
 * branch is ignored; links point at the deployed commit), or an ssh remote. Undefined if it is none of these.
 */
export function parseGithubLocation(value: string | undefined): GithubLocation | undefined {
  if (!value) return undefined;
  const rest = value.trim().replace(PREFIX, '').replace(/\/+$/, '');
  const [owner, rawName, ...path] = rest.split('/');
  const name = rawName?.replace(/\.git$/, '');
  // GitHub owners are letters, digits, and hyphens, so a host such as gitlab.com cannot pass as one.
  if (!owner || !name || !/^[A-Za-z0-9-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return undefined;
  // Browser URLs carry /tree/{branch}/ or /blob/{branch}/ before the path.
  const root = (path[0] === 'tree' || path[0] === 'blob') ? path.slice(2) : path;
  if (root.some(part => !part || part === '.' || part === '..' || !/^[\w.@+-]+$/.test(part))) return undefined;
  return { repo: `${owner}/${name}`, root: root.join('/') };
}

/** `owner/name` from any form `parseGithubLocation` accepts, ignoring a root directory. */
export function parseGithubRepo(value: string | undefined): string | undefined {
  return parseGithubLocation(value)?.repo;
}

export function githubCommitUrl(repo: string, gitSha: string): string {
  return `https://github.com/${repo}/commit/${gitSha}`;
}

/**
 * Link to a file (and line) at a commit. The path is Skylight's source location name, relative to the app's root;
 * pass a `GithubLocation` with a root for apps in a subdirectory.
 */
export function githubFileUrl(repo: string | GithubLocation, gitSha: string, path: string, line?: number | null): string {
  const { repo: name, root } = typeof repo === 'string' ? { repo, root: '' } : repo;
  const encoded = [...(root ? root.split('/') : []), ...path.split('/')].map(encodeURIComponent).join('/');
  return `https://github.com/${name}/tree/${gitSha}/${encoded}${line ? `#L${line}` : ''}`;
}

/** OSC 8 terminal hyperlink: the text stays as-is in terminals without support. */
export function terminalLink(text: string, url: string): string {
  return `\u001B]8;;${url}\u001B\\${text}\u001B]8;;\u001B\\`;
}
