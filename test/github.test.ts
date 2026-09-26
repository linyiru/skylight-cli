import test from 'node:test';
import assert from 'node:assert/strict';
import { githubCommitUrl, githubFileUrl, parseGithubLocation, parseGithubRepo, terminalLink } from '../src/github.ts';

test('accepts owner/name and github.com URLs, rejects anything else', () => {
  for (const value of ['kaikhq/app', 'github.com/kaikhq/app', 'www.github.com/kaikhq/app', 'http://github.com/kaikhq/app',
    'https://github.com/kaikhq/app', 'https://github.com/kaikhq/app.git',
    'git@github.com:kaikhq/app.git', 'ssh://git@github.com/kaikhq/app']) {
    assert.equal(parseGithubRepo(value), 'kaikhq/app', value);
  }
  for (const value of ['', 'app', 'https://gitlab.com/kaikhq/app', 'gitlab.com/kaikhq/app', 'not a repo', 'kaikhq/app/../etc']) {
    assert.equal(parseGithubRepo(value), undefined, value);
  }
});

test('a monorepo app directory comes from extra path segments or a pasted browser URL', () => {
  for (const value of ['kaikhq/app/apps/rails', 'github.com/kaikhq/app/apps/rails/',
    'https://github.com/kaikhq/app/tree/develop/apps/rails', 'https://github.com/kaikhq/app/blob/main/apps/rails']) {
    assert.deepEqual(parseGithubLocation(value), { repo: 'kaikhq/app', root: 'apps/rails' }, value);
  }
  assert.deepEqual(parseGithubLocation('https://github.com/kaikhq/app/tree/main'), { repo: 'kaikhq/app', root: '' });
  assert.equal(parseGithubRepo('kaikhq/app/apps/rails'), 'kaikhq/app');
  assert.equal(githubFileUrl({ repo: 'o/r', root: 'apps/rails' }, 'abc', 'app/models/user.rb', 3),
    'https://github.com/o/r/tree/abc/apps/rails/app/models/user.rb#L3');
});

test('builds links as Skylight does: tree/{sha}/{path}#L{line} and commit/{sha}', () => {
  assert.equal(githubFileUrl('o/r', 'abc123', 'app/models/user.rb', 12), 'https://github.com/o/r/tree/abc123/app/models/user.rb#L12');
  assert.equal(githubFileUrl('o/r', 'abc123', 'app/views/a b.erb'), 'https://github.com/o/r/tree/abc123/app/views/a%20b.erb');
  assert.equal(githubCommitUrl('o/r', 'abc123'), 'https://github.com/o/r/commit/abc123');
});

test('terminal links wrap text in OSC 8', () => {
  assert.equal(terminalLink('x.rb:1', 'https://e.x'), '\u001B]8;;https://e.x\u001B\\x.rb:1\u001B]8;;\u001B\\');
});
