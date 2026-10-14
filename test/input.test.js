import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBody, readReviewComments } from '../src/input.js';
import { fileURLToPath } from 'node:url';
import { httpMock, invoke } from './helpers.js';

test('body-file reads UTF-8 and stdin input without prompting', async () => {
  assert.equal(
    await readBody({ 'body-file': '-' }, true, Readable.from(['line one\n', 'line two'])),
    'line one\nline two',
  );
  await assert.rejects(readBody({ 'body-file': '-' }, true, { isTTY: true }), { exitCode: 2 });
  await assert.rejects(readBody({ 'body-file': '/file-that-does-not-exist-any-skill' }), {
    exitCode: 2,
  });
});

test('body files share the 1 MiB input limit with standard input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'any-skill-github-'));
  const path = join(directory, 'body.md');

  try {
    await writeFile(path, 'body from a file');
    assert.equal(await readBody({ 'body-file': path }), 'body from a file');
    await writeFile(path, Buffer.alloc(1024 * 1024 + 1, 'a'));
    await assert.rejects(readBody({ 'body-file': path }), {
      exitCode: 2,
      message: 'Body input exceeds 1 MiB.',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inline review JSON is validated before creating a review', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/inline-comments.json', import.meta.url));
  const comments = await readReviewComments(fixture);

  assert.equal(comments[0].side, 'RIGHT');

  const mock = httpMock([
    { data: { head: { sha: 'sha' } } },
    {
      body: { event: 'COMMENT', comments, commit_id: 'sha' },
      data: { id: 10, state: 'COMMENTED' },
    },
  ]);
  const result = await invoke(
    [
      'review-submit',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--event',
      'comment',
      '--comments-file',
      fixture,
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  mock.done();
});

test('non-comment JSON is rejected as inline review input', async () => {
  const path = fileURLToPath(new URL('../package.json', import.meta.url));

  await assert.rejects(readReviewComments(path), { exitCode: 2 });
});
