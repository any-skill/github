import test from 'node:test';
import assert from 'node:assert/strict';
import { httpMock, invoke } from './helpers.js';

const issue = { id: 1, number: 123, updated_at: '2026-01-02T00:00:00Z' };
const pr = { id: 2, node_id: 'PR_node', number: 123, head: { sha: 'abcdef' }, changed_files: 2 };

test('issue-create maps repeated metadata and does not invoke Git', async () => {
  const mock = httpMock([
    {
      method: 'POST',
      path: '/repos/owner/repo/issues',
      body: { title: 'Fix startup', body: 'Description', labels: ['bug'], assignees: ['octocat'] },
      data: issue,
    },
  ]);
  const result = await invoke(
    [
      'issue-create',
      '--repo',
      'owner/repo',
      '--title',
      'Fix startup',
      '--body',
      'Description',
      '--label',
      'bug',
      '--assignee',
      'octocat',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.number, 123);
  mock.done();
});

test('issue-get rejects PR numbers and issue-close makes no mutation for a PR', async () => {
  const mock = httpMock([{ data: { ...issue, pull_request: {} } }]);
  const result = await invoke(['issue-close', '--repo', 'owner/repo', '--number', '123'], mock);

  assert.equal(result.exitCode, 2);
  mock.done();
});

for (const [name, state] of [
  ['issue-close', 'closed'],
  ['issue-reopen', 'open'],
]) {
  test(`${name} verifies the issue then uses PATCH`, async () => {
    const mock = httpMock([
      { data: issue },
      { method: 'PATCH', body: { state }, data: { ...issue, state } },
    ]);
    const result = await invoke([name, '--repo', 'owner/repo', '--number', '123'], mock);

    assert.equal(result.exitCode, 0);
    assert.equal(result.output.data.state, state);
    mock.done();
  });
}

test('issue-update can explicitly clear labels and rejects an empty update', async () => {
  const mock = httpMock([{ data: issue }, { body: { labels: [] }, data: issue }]);
  const result = await invoke(
    ['issue-update', '--repo', 'owner/repo', '--number', '123', '--clear-labels'],
    mock,
  );
  const invalid = await invoke(
    ['issue-update', '--repo', 'owner/repo', '--number', '123'],
    httpMock([]),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(invalid.exitCode, 2);
  mock.done();
});

test('PR comment update verifies both parent type and comment association', async () => {
  const mock = httpMock([
    { data: pr },
    { data: { id: 456, issue_url: 'https://api.github.com/repos/owner/repo/issues/999' } },
  ]);
  const result = await invoke(
    [
      'pr-comment-update',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--comment-id',
      '456',
      '--body',
      'Changed',
    ],
    mock,
  );

  assert.equal(result.exitCode, 2);
  mock.done();
});

test('issue-comment-create requires a body before making a request', async () => {
  const mock = httpMock([]);
  const result = await invoke(
    ['issue-comment-create', '--repo', 'owner/repo', '--number', '123'],
    mock,
  );

  assert.equal(result.exitCode, 2);
  mock.done();
});

test('PR comments and inline review comments use distinct APIs', async () => {
  const mock = httpMock([
    { path: '/repos/owner/repo/pulls/123', data: pr },
    { path: '/repos/owner/repo/issues/123/comments', data: [] },
  ]);
  const result = await invoke(['pr-comment-list', '--repo', 'owner/repo', '--number', '123'], mock);

  assert.equal(result.exitCode, 0);
  mock.done();

  const inline = httpMock([
    {
      path: '/repos/owner/repo/pulls/123/comments',
      query: { since: '2026-01-01T00:00:00Z' },
      data: [],
    },
  ]);

  assert.equal(
    (
      await invoke(
        [
          'review-comment-list',
          '--repo',
          'owner/repo',
          '--number',
          '123',
          '--since',
          '2026-01-01T00:00:00Z',
        ],
        inline,
      )
    ).exitCode,
    0,
  );
  inline.done();
});

test('pr-create refuses an existing head PR without issuing POST', async () => {
  const mock = httpMock([
    {
      method: 'GET',
      query: { head: 'owner:feature', state: 'open' },
      data: [{ number: 123, html_url: 'https://github.com/owner/repo/pull/123' }],
    },
  ]);
  const result = await invoke(
    ['pr-create', '--repo', 'owner/repo', '--head', 'feature', '--base', 'main', '--title', 'Fix'],
    mock,
  );

  assert.equal(result.exitCode, 8);
  assert.equal(result.error.code, 'ALREADY_EXISTS');
  assert.equal(result.error.number, 123);
  mock.done();
});

test('pr-create checks the branch then creates with explicit base/head', async () => {
  const mock = httpMock([
    { data: [] },
    {
      method: 'POST',
      path: '/repos/owner/repo/pulls',
      body: { title: 'Fix', head: 'fork:feature', base: 'main', draft: true },
      data: pr,
    },
  ]);
  const result = await invoke(
    [
      'pr-create',
      '--repo',
      'owner/repo',
      '--head',
      'fork:feature',
      '--base',
      'main',
      '--title',
      'Fix',
      '--draft',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  mock.done();
});

test('pr-list filters merged and updated results locally', async () => {
  const mock = httpMock([
    {
      query: { state: 'closed' },
      data: [
        { id: 1, merged_at: null, updated_at: '2026-01-02T00:00:00Z' },
        { id: 2, merged_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        { id: 3, merged_at: '2025-12-31T00:00:00Z', updated_at: '2025-12-31T00:00:00Z' },
      ],
    },
  ]);
  const result = await invoke(
    ['pr-list', '--repo', 'owner/repo', '--state', 'merged', '--since', '2026-01-01T00:00:00Z'],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    result.output.data.map((entry) => entry.id),
    [2],
  );
  mock.done();
});

test('pr-get retains unknown mergeability and separate review/merge statuses', async () => {
  const mock = httpMock([
    { data: { ...pr, mergeable: null } },
    {
      path: '/graphql',
      data: {
        data: {
          repository: {
            pullRequest: {
              reviewDecision: 'CHANGES_REQUESTED',
              mergeStateStatus: 'UNKNOWN',
              mergeable: 'UNKNOWN',
            },
          },
        },
      },
    },
  ]);
  const result = await invoke(['pr-get', '--repo', 'owner/repo', '--number', '123'], mock);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.mergeable, null);
  assert.equal(result.output.data.reviewDecision, 'CHANGES_REQUESTED');
  assert.equal(result.output.data.graphqlMergeable, 'UNKNOWN');
  mock.done();
});

test('pr-files reports upstream caps instead of claiming a complete list', async () => {
  const mock = httpMock([
    { data: { ...pr, changed_files: 3001 } },
    { data: [{ filename: 'first.js' }] },
  ]);
  const result = await invoke(['pr-files', '--repo', 'owner/repo', '--number', '123'], mock);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.meta.pagination.complete, false);
  assert.equal(result.output.meta.pagination.apiLimit, 3000);
  mock.done();
});

test('review-submit binds a decision to the observed head and preserves self-review errors', async () => {
  const mock = httpMock([
    { data: pr },
    {
      method: 'POST',
      path: '/repos/owner/repo/pulls/123/reviews',
      body: { event: 'APPROVE', commit_id: 'abcdef' },
      status: 422,
      data: { message: 'Can not approve your own pull request' },
    },
  ]);
  const result = await invoke(
    ['review-submit', '--repo', 'owner/repo', '--number', '123', '--event', 'approve'],
    mock,
  );

  assert.equal(result.exitCode, 8);
  assert.equal(result.error.status, 422);
  mock.done();
});

test('an explicit commit SHA and PR updates skip redundant PR reads', async () => {
  const review = httpMock([
    {
      method: 'POST',
      path: '/repos/owner/repo/pulls/123/reviews',
      body: { event: 'COMMENT', body: 'Looks fine', commit_id: 'given-sha' },
      data: { id: 10, state: 'COMMENTED' },
    },
  ]);
  const update = httpMock([
    {
      method: 'PATCH',
      path: '/repos/owner/repo/pulls/123',
      body: { title: 'Renamed' },
      data: pr,
    },
  ]);

  for (const [args, mock] of [
    [
      ['review-submit', '--event', 'comment', '--body', 'Looks fine', '--commit-sha', 'given-sha'],
      review,
    ],
    [['pr-update', '--title', 'Renamed'], update],
  ]) {
    const result = await invoke([...args, '--repo', 'owner/repo', '--number', '123'], mock);

    assert.equal(result.exitCode, 0, result.stderr);
    mock.done();
  }
});

test('review reply uses the root comment ID after verifying the PR', async () => {
  const mock = httpMock([
    {
      path: '/repos/owner/repo/pulls/comments/456',
      data: {
        id: 456,
        in_reply_to_id: 400,
        pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/123',
      },
    },
    {
      method: 'POST',
      path: '/repos/owner/repo/pulls/123/comments/400/replies',
      body: { body: 'Fixed' },
      data: { id: 457 },
    },
  ]);
  const result = await invoke(
    [
      'review-comment-reply',
      '--repo',
      'owner/repo',
      '--number',
      '123',
      '--comment-id',
      '456',
      '--body',
      'Fixed',
    ],
    mock,
  );

  assert.equal(result.exitCode, 0);
  mock.done();
});

test('request-changes and inline creation require validated non-empty inputs', async () => {
  for (const args of [
    ['review-submit', '--event', 'request-changes'],
    ['review-comment-create', '--path', 'file.js', '--line', '10', '--side', 'RIGHT'],
  ]) {
    const mock = httpMock([]);
    const result = await invoke([...args, '--repo', 'owner/repo', '--number', '123'], mock);

    assert.equal(result.exitCode, 2);
    mock.done();
  }
});

for (const [name, operation, isDraft] of [
  ['pr-draft', 'convertPullRequestToDraft', true],
  ['pr-ready', 'markPullRequestReadyForReview', false],
]) {
  test(`${name} uses the supported GraphQL mutation`, async () => {
    const mock = httpMock([
      { data: pr },
      {
        method: 'POST',
        path: '/graphql',
        inspect({ body }) {
          assert.match(body.query, new RegExp(operation));
          assert.equal(body.variables.id, 'PR_node');
        },
        data: { data: { [operation]: { pullRequest: { id: 'PR_node', number: 123, isDraft } } } },
      },
    ]);
    const result = await invoke([name, '--repo', 'owner/repo', '--number', '123'], mock);

    assert.equal(result.exitCode, 0);
    assert.equal(result.output.data.isDraft, isDraft);
    mock.done();
  });
}
