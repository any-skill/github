import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArguments } from '../src/arguments.js';
import { commands } from '../src/commands.js';
import { repositoryFromRemote, resolveRepository } from '../src/repository.js';
import { invoke } from './helpers.js';

test('global options can precede or follow the command and labels are repeatable', () => {
  const result = parseArguments(
    ['--repo', 'owner/repo', 'issue-list', '--label', 'bug', '--label', 'urgent', '--all'],
    commands,
  );

  assert.equal(result.command.name, 'issue-list');
  assert.deepEqual(result.options.label, ['bug', 'urgent']);
  assert.equal(result.options['per-page'], 50);
  assert.equal(result.options.all, true);
});

for (const args of [
  [],
  ['missing'],
  ['issue-get'],
  ['issue-get', '--number', '0'],
  ['issue-get', '--number', '1.5'],
  ['issue-get', '--number', '9007199254740992'],
  ['repo-get', '--all'],
  ['issue-list', '--state', 'merged'],
  ['issue-list', '--per-page', '101'],
  ['issue-list', '--since', '2026-01-01'],
  ['issue-list', '--since', '2026-01-01T00:00:00'],
  ['issue-create', '--title', 'x', '--body', 'x', '--body-file', 'file.md'],
  ['repo-comment-list', '--all', '--if-none-match', 'etag'],
  ['pr-get', '123'],
  ['issue-list', '--unknown'],
  ['issue-get', '--number', ''],
]) {
  test(`reject invalid arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => parseArguments(args, commands), { exitCode: 2 });
  });
}

test('help/version need no credentials or repository', async () => {
  const help = await invoke(['pr-create', '--help'], undefined, { env: {} });
  const version = await invoke(['--version'], undefined, { env: {} });

  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /--head/);
  assert.equal(version.stdout, '1.0.0\n');
});

test('per-command scalar/repeatable definitions are respected', () => {
  assert.equal(
    parseArguments(['issue-list', '--assignee', 'octocat'], commands).options.assignee,
    'octocat',
  );
  assert.throws(
    () => parseArguments(['issue-list', '--assignee', 'one', '--assignee', 'two'], commands),
    { exitCode: 2 },
  );
  assert.throws(
    () => parseArguments(['repo-get', '--repo', 'one/repo', '--repo', 'two/repo'], commands),
    { exitCode: 2 },
  );
});

test('missing authentication uses stderr and leaves stdout empty', async () => {
  const result = await invoke(['repo-get', '--repo', 'owner/repo'], undefined, { env: {} });

  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, '');
  assert.equal(result.error.code, 'TOKEN_REQUIRED');
});

test('remote parsing handles GitHub SSH and HTTPS without accepting other hosts', () => {
  for (const remote of [
    'git@github.com:owner/repo.git',
    'https://github.com/owner/repo.git',
    'ssh://git@github.com/owner/repo.git',
    'https://github.com/owner/repo',
  ]) {
    assert.equal(repositoryFromRemote(remote).fullName, 'owner/repo');
  }
  assert.equal(repositoryFromRemote('https://github.example.com/owner/repo.git'), null);
});

test('origin wins, ambiguous remotes fail, and explicit repo does not invoke Git', async () => {
  const git = async () => ({
    stdout:
      'upstream\tgit@github.com:up/project.git (fetch)\norigin\tgit@github.com:me/project.git (fetch)\n',
  });

  assert.equal((await resolveRepository(undefined, '.', git)).fullName, 'me/project');
  await assert.rejects(
    resolveRepository(undefined, '.', async () => ({
      stdout:
        'first\tgit@github.com:a/repo.git (fetch)\nsecond\tgit@github.com:b/repo.git (fetch)\n',
    })),
    { exitCode: 2 },
  );
  assert.equal(
    (
      await resolveRepository('explicit/repo', '.', async () => {
        throw new Error('Must not call Git');
      })
    ).fullName,
    'explicit/repo',
  );
});
