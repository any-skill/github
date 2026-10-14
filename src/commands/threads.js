import { command, string, number, graphPaging } from '../options.js';
import { CliError, expectObject, usage } from '../errors.js';

const group = 'Review Threads';
const threadId = { 'thread-id': string('GraphQL review thread node ID.') };
const threadFields = `id isResolved isOutdated path line startLine diffSide startDiffSide
  originalLine originalStartLine resolvedBy { login }
  viewerCanReply viewerCanResolve viewerCanUnresolve`;
const commentFields = `id: databaseId nodeId: id body createdAt updatedAt url
  author { login } pullRequestReview { id state submittedAt }`;
const listQuery = `query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        totalCount pageInfo {hasNextPage endCursor}
        nodes { ${threadFields}
          comments(first: 10) { totalCount pageInfo {hasNextPage endCursor} nodes {${commentFields}} }
        }
      }
    }
  }
}`;
const getQuery = `query($id: ID!, $first: Int!, $after: String) {
  node(id: $id) { ... on PullRequestReviewThread { ${threadFields}
    repository {nameWithOwner} pullRequest {number}
    comments(first: $first, after: $after) {totalCount pageInfo {hasNextPage endCursor} nodes {${commentFields}}}
  } }
}`;
const identityQuery = `query($id: ID!) {
  node(id: $id) { ... on PullRequestReviewThread { ${threadFields}
    repository {nameWithOwner} pullRequest {number}
  } }
}`;

function verifyThread(ctx, opts, thread) {
  if (!thread?.repository || !thread.pullRequest) {
    throw new CliError('NOT_FOUND', 'Review thread not found or not visible.', 5);
  }
  if (
    thread.repository.nameWithOwner.toLowerCase() !== ctx.repository.fullName.toLowerCase() ||
    thread.pullRequest.number !== opts.number
  ) {
    throw usage('Thread does not belong to the selected repository and PR.');
  }

  return thread;
}

async function resolve(ctx, opts, resolved) {
  const data = await ctx.graph(identityQuery, { id: opts['thread-id'] });
  const current = verifyThread(ctx, opts, data.node);
  const allowed = resolved ? current.viewerCanResolve : current.viewerCanUnresolve;

  if (current.isResolved === resolved) {
    return { data: current, meta: { unchanged: true } };
  }
  if (!allowed) {
    throw new CliError(
      'PERMISSION_DENIED',
      'GitHub reports that this token cannot change this thread resolution.',
      4,
    );
  }

  const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
  const result = await ctx.graph(
    `mutation($id: ID!) {
    ${operation}(input: {threadId: $id}) { thread {${threadFields}} }
  }`,
    { id: opts['thread-id'] },
  );

  return { data: expectObject(result[operation]?.thread), meta: {} };
}

export const threadCommands = [
  command(
    'review-thread-list',
    group,
    'Read review threads, resolution state and a bounded comment preview.',
    {
      ...number,
      ...graphPaging,
      state: string('Thread resolution filter, applied locally.', {
        choices: ['all', 'resolved', 'unresolved'],
        default: 'all',
      }),
    },
    ['number'],
    'review-thread-list --repo any-skill/github --number 123 --state unresolved --all',
    'data: thread array with GraphQL id, isResolved/isOutdated and comments {nodes,totalCount,pageInfo}. meta.commentsComplete covers previews.',
    '--all paginates threads only. Each preview contains at most 10 comments with its own continuation. Use review-thread-get --all for complete comments. There is no timestamp filter for resolution changes.',
    async (ctx, opts) => {
      const result = await ctx.connection(
        listQuery,
        { number: opts.number },
        (data) => data.repository?.pullRequest?.reviewThreads,
        (thread) => opts.state === 'all' || thread.isResolved === (opts.state === 'resolved'),
      );

      result.meta.commentsComplete = result.data.every(
        (thread) => !thread.comments.pageInfo.hasNextPage,
      );
      result.meta.complete = result.meta.pagination.complete && result.meta.commentsComplete;

      return result;
    },
  ),
  command(
    'review-thread-get',
    group,
    'Read a thread and paginate its entire comment connection.',
    { ...number, ...threadId, ...graphPaging },
    ['number', 'thread-id'],
    'review-thread-get --repo any-skill/github --number 123 --thread-id PRRT_example --all',
    'data: thread metadata with comments as an array. meta.pagination applies to comments and nextCursor resumes that connection.',
    'The thread repository/PR is verified. --all reads every remaining comment page; without it only one page is returned.',
    async (ctx, opts) => {
      let thread;
      const result = await ctx.connection(getQuery, { id: opts['thread-id'] }, (data) => {
        thread = verifyThread(ctx, opts, data.node);

        return thread.comments;
      });
      const { comments: _comments, ...metadata } = thread;

      return { data: { ...metadata, comments: result.data }, meta: result.meta };
    },
  ),
  command(
    'review-thread-resolve',
    group,
    'Mark a review thread resolved.',
    { ...number, ...threadId },
    ['number', 'thread-id'],
    'review-thread-resolve --repo any-skill/github --number 123 --thread-id PRRT_example',
    'data: thread metadata; meta.unchanged=true when already resolved.',
    'Checks repository, PR and viewerCanResolve before mutation. Resolving feedback does not approve a PR.',
    (ctx, opts) => resolve(ctx, opts, true),
  ),
  command(
    'review-thread-unresolve',
    group,
    'Reopen a resolved review thread.',
    { ...number, ...threadId },
    ['number', 'thread-id'],
    'review-thread-unresolve --repo any-skill/github --number 123 --thread-id PRRT_example',
    'data: thread metadata; meta.unchanged=true when already unresolved.',
    'Checks repository, PR and viewerCanUnresolve before mutation.',
    (ctx, opts) => resolve(ctx, opts, false),
  ),
];
