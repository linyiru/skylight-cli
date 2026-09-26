/**
 * GitHub links as Skylight's UI builds them (direwolf `models/deploy`): tree/{sha}/{path}#L{line} and commit/{sha}.
 * Skylight knows the app's repo, but only behind a web login (/apps/{id} answers 401 to an MCP session), so the
 * repo is passed in: `owner/name`.
 */

/** `owner/name`, from that form or a github.com URL (https or ssh); undefined if it is neither. */
export function parseGithubRepo(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(value.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function githubCommitUrl(repo: string, gitSha: string): string {
  return `https://github.com/${repo}/commit/${gitSha}`;
}

/** Link to a file (and line) at a commit; the path is Skylight's source location name, relative to the repo root. */
export function githubFileUrl(repo: string, gitSha: string, path: string, line?: number | null): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repo}/tree/${gitSha}/${encoded}${line ? `#L${line}` : ''}`;
}

/** OSC 8 terminal hyperlink: the text stays as-is in terminals without support. */
export function terminalLink(text: string, url: string): string {
  return `\u001B]8;;${url}\u001B\\${text}\u001B]8;;\u001B\\`;
}
