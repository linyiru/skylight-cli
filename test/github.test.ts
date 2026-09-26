import test from 'node:test';
import assert from 'node:assert/strict';
import { githubCommitUrl, githubFileUrl, parseGithubRepo, terminalLink } from '../src/github.ts';

test('accepts owner/name and github.com URLs, rejects anything else', () => {
  for (const value of ['kaikhq/app', 'https://github.com/kaikhq/app', 'https://github.com/kaikhq/app.git',
    'git@github.com:kaikhq/app.git', 'ssh://git@github.com/kaikhq/app']) {
    assert.equal(parseGithubRepo(value), 'kaikhq/app', value);
  }
  for (const value of ['', 'app', 'https://gitlab.com/kaikhq/app', 'kaikhq/app/tree/main', 'not a repo']) {
    assert.equal(parseGithubRepo(value), undefined, value);
  }
});

test('builds links as Skylight does: tree/{sha}/{path}#L{line} and commit/{sha}', () => {
  assert.equal(githubFileUrl('o/r', 'abc123', 'app/models/user.rb', 12), 'https://github.com/o/r/tree/abc123/app/models/user.rb#L12');
  assert.equal(githubFileUrl('o/r', 'abc123', 'app/views/a b.erb'), 'https://github.com/o/r/tree/abc123/app/views/a%20b.erb');
  assert.equal(githubCommitUrl('o/r', 'abc123'), 'https://github.com/o/r/commit/abc123');
});

test('terminal links wrap text in OSC 8', () => {
  assert.equal(terminalLink('x.rb:1', 'https://e.x'), '\u001B]8;;https://e.x\u001B\\x.rb:1\u001B]8;;\u001B\\');
});
