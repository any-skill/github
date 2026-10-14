import test from 'node:test';
import assert from 'node:assert/strict';
import { httpMock, invoke } from './helpers.js';

const identity = {
  id: 'PRRT_node',
  isResolved: false,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  repository: { nameWithOwner: 'owner/repo' },
  pullRequest: { number: 123 },
};
const connection = (nodes, hasNextPage = false, endCursor = null, totalCount = nodes.length) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
  totalCount,
});

test('thread-list paginates outer threads and explicitly reports incomplete nested previews', async () => {
  const mock = httpMock([
    {
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: connection(
                [
                  {
                    id: 'one',
                    isResolved: false,
                    comments: connection([{ id: 1 }], true, 'comment-next', 11),
                  },
                ],
                true,
                'thread-next',
                2,
              ),
            },
          },
        },
      },
    },
    {
      inspect({ body }) {
        assert.equal(body.variables.after, 'thread-next');
      },
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: connection(
                [{ id: 'two', isResolved: true, comments: connection([]) }],
                false,
                'last',
                2,
              ),
            },
          },
        },
      },
    },
  ]);
  const result = await invoke(
    [
      'review-thread-list',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--state',
      'unresolved',
      '--all',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.length, 1);
  assert.equal(result.output.meta.pagination.complete, true);
  assert.equal(result.output.meta.commentsComplete, false);
  assert.equal(result.output.meta.complete, false);
  mock.done();
});

test('thread-get reads every nested comment page rather than truncating at 50', async () => {
  const first = Array.from({ length: 50 }, (_value, index) => ({
    id: index + 1,
    updatedAt: '2026-01-01T00:00:00Z',
  }));
  const mock = httpMock([
    {
      data: {
        data: { node: { ...identity, comments: connection(first, true, 'comments-next', 51) } },
      },
    },
    {
      inspect({ body }) {
        assert.equal(body.variables.after, 'comments-next');
      },
      data: {
        data: { node: { ...identity, comments: connection([{ id: 51 }], false, 'last', 51) } },
      },
    },
  ]);
  const result = await invoke(
    [
      'review-thread-get',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--thread-id',
      'PRRT_node',
      '--all',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.comments.length, 51);
  assert.equal(result.output.meta.pagination.complete, true);
  mock.done();
});

test('thread resolve verifies its repository and rejects foreign threads without mutation', async () => {
  const mock = httpMock([
    { data: { data: { node: { ...identity, repository: { nameWithOwner: 'other/repo' } } } } },
  ]);
  const result = await invoke(
    [
      'review-thread-resolve',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--thread-id',
      'PRRT_node',
    ],
    mock,
  );

  assert.equal(result.exitCode, 2);
  mock.done();
});

test('thread resolve honors viewer permission and already-resolved state', async () => {
  const denied = httpMock([{ data: { data: { node: { ...identity, viewerCanResolve: false } } } }]);
  const result = await invoke(
    [
      'review-thread-resolve',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--thread-id',
      'PRRT_node',
    ],
    denied,
  );

  assert.equal(result.exitCode, 4);
  denied.done();

  const unchanged = httpMock([
    { data: { data: { node: { ...identity, isResolved: true, viewerCanResolve: false } } } },
  ]);
  const same = await invoke(
    [
      'review-thread-resolve',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--thread-id',
      'PRRT_node',
    ],
    unchanged,
  );

  assert.equal(same.exitCode, 0);
  assert.equal(same.output.meta.unchanged, true);
  unchanged.done();
});

test('thread resolution uses a GraphQL mutation after preflight', async () => {
  const mock = httpMock([
    { data: { data: { node: identity } } },
    {
      inspect({ body }) {
        assert.match(body.query, /resolveReviewThread/);
      },
      data: { data: { resolveReviewThread: { thread: { ...identity, isResolved: true } } } },
    },
  ]);
  const result = await invoke(
    [
      'review-thread-resolve',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--thread-id',
      'PRRT_node',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.isResolved, true);
  mock.done();
});

test('GraphQL partial data with errors cannot become a successful read', async () => {
  const mock = httpMock([
    { data: { data: { repository: null }, errors: [{ type: 'FORBIDDEN', message: 'Forbidden' }] } },
  ]);
  const result = await invoke(
    ['review-thread-list', '--repo', 'owner/repo', '--number', '123'],
    mock,
  );

  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, '');
  mock.done();
});

test('repeated GraphQL cursor stops rather than looping indefinitely', async () => {
  const mock = httpMock(
    [1, 2].map(() => ({
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: connection([], true, 'same', 2),
            },
          },
        },
      },
    })),
  );
  const result = await invoke(
    ['review-thread-list', '--repo', 'owner/repo', '--number', '123', '--all'],
    mock,
  );

  assert.equal(result.exitCode, 8);
  assert.equal(result.error.code, 'INVALID_RESPONSE');
  mock.done();
});
