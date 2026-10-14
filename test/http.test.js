import test from 'node:test';
import assert from 'node:assert/strict';
import { concurrently, createContext, normalize } from '../src/client.js';
import { httpMock, invoke, TOKEN } from './helpers.js';

test('success is one JSON envelope with camelCase keys and token redaction', async () => {
  const mock = httpMock([
    {
      method: 'GET',
      path: '/repos/owner/repo',
      data: { id: 1, default_branch: 'main', description: `Do not disclose ${TOKEN}` },
      headers: {
        etag: '"abc"',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '1800000000',
      },
    },
  ]);
  const result = await invoke(['repo-get', '--repo', 'owner/repo'], mock);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.output.schemaVersion, 1);
  assert.equal(result.output.data.defaultBranch, 'main');
  assert.equal(result.output.meta.etag, '"abc"');
  assert.equal(result.output.meta.rateLimit.remaining, 4999);
  assert.ok(!result.stdout.includes(TOKEN));
  assert.equal(result.stdout.trim().split('\n').length, 1);
  mock.done();
});

for (const [status, code, exitCode, headers] of [
  [401, 'AUTHENTICATION_FAILED', 3, {}],
  [403, 'PERMISSION_DENIED', 4, {}],
  [404, 'NOT_FOUND', 5, {}],
  [422, 'API_ERROR', 8, {}],
  [503, 'API_ERROR', 8, {}],
  [403, 'RATE_LIMITED', 6, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }],
  [429, 'RATE_LIMITED', 6, { 'retry-after': '60' }],
]) {
  test(`HTTP ${status} produces ${code} and no retry`, async () => {
    const mock = httpMock([{ status, headers, data: { message: `Failure ${TOKEN}` } }]);
    const result = await invoke(['repo-get', '--repo', 'owner/repo'], mock);

    assert.equal(result.exitCode, exitCode);
    assert.equal(result.error.code, code);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(TOKEN));
    mock.done();
  });
}

test('conditional 304 is a successful unchanged result', async () => {
  const mock = httpMock([
    {
      status: 304,
      headers: { etag: '"same"' },
      inspect({ init }) {
        assert.equal(init.headers['if-none-match'], '"same"');
      },
    },
  ]);
  const result = await invoke(
    ['repo-get', '--repo', 'owner/repo', '--if-none-match', '"same"'],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data, null);
  assert.equal(result.output.meta.notModified, true);
  mock.done();
});

test('real Octokit network wrapping maps to a network exit code', async () => {
  const mock = httpMock([]);

  mock.octokit.request = async () => {
    const error = new Error('DNS failure');

    error.status = 500;
    error.cause = new TypeError('fetch failed');
    throw error;
  };

  const result = await invoke(['repo-get', '--repo', 'owner/repo'], mock);

  assert.equal(result.exitCode, 7);
  assert.equal(result.error.code, 'NETWORK_ERROR');
});

test('request fetch receives an actual AbortSignal timeout', async () => {
  const previous = globalThis.fetch;
  let signal;

  globalThis.fetch = async (_url, init) => {
    signal = init.signal;

    return new Response('{"id":1}', { headers: { 'content-type': 'application/json' } });
  };

  try {
    const context = createContext(
      { owner: 'owner', repo: 'repo', fullName: 'owner/repo' },
      { timeout: 1000 },
      TOKEN,
    );

    await context.single('GET /repos/{owner}/{repo}');
    assert.ok(signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = previous;
  }
});

test('concurrent requests report failures in argument order', async () => {
  const first = new Error('first');
  const slow = new Promise((_resolve, reject) => setTimeout(() => reject(first), 10));

  await assert.rejects(concurrently(slow, Promise.reject(new Error('second'))), first);
  assert.deepEqual(await concurrently(Promise.resolve(1), 2), [1, 2]);
});

test('BigInt IDs normalize losslessly for JSON', () => {
  assert.deepEqual(normalize({ id: 9007199254740993n, node_id: 'node' }), {
    id: '9007199254740993',
    nodeId: 'node',
  });
});

test('issues paging follows Link even when a page contains only PRs', async () => {
  const mock = httpMock([
    {
      path: '/repos/owner/repo/issues',
      query: { page: 1, per_page: 1, since: '2026-01-01T00:00:00Z', creator: 'octocat' },
      data: [{ id: 1, pull_request: {} }],
      headers: {
        link: '<https://api.github.com/repos/owner/repo/issues?page=2&per_page=1>; rel="next"',
      },
    },
    { query: { page: 2 }, data: [{ id: 2, number: 2, updated_at: '2026-01-02T00:00:00Z' }] },
  ]);
  const result = await invoke(
    [
      'issue-list',
      '--repo',
      'owner/repo',
      '--all',
      '--per-page',
      '1',
      '--author',
      'octocat',
      '--since',
      '2026-01-01T00:00:00Z',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.output.data.map((entry) => entry.id),
    [2],
  );
  assert.equal(result.output.meta.pagination.complete, true);
  mock.done();
});

test('one page preserves continuation, incomplete search metadata and native query scope', async () => {
  const mock = httpMock([
    {
      path: '/search/issues',
      query: { q: 'repo:owner/repo is:issue (is:open)' },
      data: {
        total_count: 2000,
        incomplete_results: true,
        items: [{ id: 2, repository_url: 'https://api.github.com/repos/owner/repo' }],
      },
      headers: { link: '<https://api.github.com/search/issues?page=2>; rel="next"' },
    },
  ]);
  const result = await invoke(['issue-search', '--repo', 'owner/repo', '--query', 'is:open'], mock);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.meta.pagination.totalCount, 2000);
  assert.equal(result.output.meta.pagination.apiLimit, 1000);
  assert.equal(result.output.meta.pagination.incompleteResults, true);
  assert.equal(result.output.meta.pagination.nextPage, 2);
  mock.done();
});

test('a later-page error discards earlier partial data', async () => {
  const mock = httpMock([
    {
      data: [{ id: 1 }],
      headers: { link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"' },
    },
    { status: 403, data: { message: 'Forbidden' } },
  ]);
  const result = await invoke(['issue-list', '--repo', 'owner/repo', '--all'], mock);

  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '');
  mock.done();
});

test('search cannot return another repository or the wrong resource kind', async () => {
  const mock = httpMock([
    {
      data: {
        total_count: 3,
        incomplete_results: false,
        items: [
          { id: 1, repository_url: 'https://api.github.com/repos/other/repo' },
          { id: 2, repository_url: 'https://api.github.com/repos/owner/repo', pull_request: {} },
          { id: 3, repository_url: 'https://api.github.com/repos/owner/repo' },
        ],
      },
    },
  ]);
  const result = await invoke(
    ['issue-search', '--repo', 'owner/repo', '--query', 'is:open OR is:closed'],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.output.data.map((entry) => entry.id),
    [3],
  );
  mock.done();
});
