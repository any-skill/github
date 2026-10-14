import {
  command,
  string,
  integer,
  number,
  commentId,
  body,
  restPaging,
  since,
} from '../options.js';
import { readBody, readReviewComments } from '../input.js';
import { usage } from '../errors.js';
import { getPull } from './pulls.js';

const group = 'Reviews';
const reviewId = { 'review-id': integer('Numeric review ID.') };
const result =
  'data: Review object/array including id, nodeId, state, submittedAt, commitId and user.';
const commentResult =
  'data: Inline review comment object/array including id, nodeId, path, line, side, inReplyToId, createdAt and updatedAt.';

// An explicit --commit-sha needs no lookup; otherwise bind to the currently observed PR head.
async function reviewedSha(ctx, opts) {
  return opts['commit-sha'] ?? (await getPull(ctx, opts.number)).data.head.sha;
}

async function getComment(ctx, opts) {
  const current = await ctx.single('GET /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
    comment_id: opts['comment-id'],
  });
  const parent = current.data.pullRequestUrl?.match(/\/pulls\/(\d+)$/)?.[1];

  if (Number(parent) !== opts.number) {
    throw usage('Inline comment does not belong to the selected PR.');
  }

  return current;
}

export const reviewCommands = [
  command(
    'review-list',
    group,
    'Read submitted and visible pending PR reviews.',
    { ...number, ...restPaging, ...since },
    ['number'],
    'review-list --repo any-skill/github --number 123 --all',
    result,
    '--since filters submittedAt locally and excludes pending reviews. It only discovers new submissions; reread all reviews for edits/dismissals/state changes.',
    (ctx, opts) =>
      ctx.list(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        { pull_number: opts.number },
        (entry) => !opts.since || Date.parse(entry.submitted_at) > Date.parse(opts.since),
      ),
  ),
  command(
    'review-get',
    group,
    'Read one PR review.',
    { ...number, ...reviewId },
    ['number', 'review-id'],
    'review-get --repo any-skill/github --number 123 --review-id 456',
    result,
    'Pending reviews may lack submittedAt and may only be visible to their author.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}', {
        pull_number: opts.number,
        review_id: opts['review-id'],
      }),
  ),
  command(
    'review-submit',
    group,
    'Create and immediately submit an official GitHub PR review.',
    {
      ...number,
      ...body,
      event: string('Review decision.', { choices: ['approve', 'request-changes', 'comment'] }),
      'commit-sha': string('Reviewed commit SHA; defaults to the currently observed PR head.'),
      'comments-file': string(
        'UTF-8 JSON array of inline comments (path, body, line, side; optional start_line/start_side).',
      ),
    },
    ['number', 'event'],
    'review-submit --repo any-skill/github --number 123 --event request-changes --body "Please handle the empty case"',
    result,
    'request-changes requires a non-empty body; comment requires body or inline comments. GitHub rejects self-approval/self-requested-changes and invalid diff locations. No pending review is created implicitly.',
    async (ctx, opts) => {
      const text = await readBody(opts, opts.event === 'request-changes');
      const comments = await readReviewComments(opts['comments-file']);

      if (opts.event === 'comment' && !text?.trim() && !comments?.length) {
        throw usage('A comment review needs a non-empty body or --comments-file.');
      }

      return ctx.single('POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        pull_number: opts.number,
        event: { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' }[
          opts.event
        ],
        body: text,
        comments,
        commit_id: await reviewedSha(ctx, opts),
      });
    },
  ),
  command(
    'review-comment-list',
    group,
    'Read PR inline review comments, including replies.',
    { ...number, ...restPaging, ...since },
    ['number'],
    'review-comment-list --repo any-skill/github --number 123 --since 2026-01-01T00:00:00Z --all',
    commentResult,
    '--since is a native updated-time filter. This endpoint does not supply thread resolution state; use review-thread-list.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
        pull_number: opts.number,
        since: opts.since,
        sort: 'updated',
        direction: 'asc',
      }),
  ),
  command(
    'review-comment-get',
    group,
    'Read an inline comment and verify its PR.',
    { ...number, ...commentId },
    ['number', 'comment-id'],
    'review-comment-get --repo any-skill/github --number 123 --comment-id 456',
    commentResult,
    'Conversation comment IDs belong to the separate issue-comment/PR-comment API.',
    getComment,
  ),
  command(
    'review-comment-create',
    group,
    'Add an inline comment on a PR diff.',
    {
      ...number,
      ...body,
      path: string('Repository-relative changed file path.'),
      line: integer('Line number in the diff.'),
      side: string('Diff side.', { choices: ['LEFT', 'RIGHT'] }),
      'start-line': integer('First line for a multi-line comment.'),
      'start-side': string('Side of the first line.', { choices: ['LEFT', 'RIGHT'] }),
      'commit-sha': string('Reviewed SHA; defaults to the currently observed PR head.'),
    },
    ['number', 'path', 'line', 'side'],
    'review-comment-create --repo any-skill/github --number 123 --path src/main.js --line 10 --side RIGHT --body "Handle the empty input"',
    commentResult,
    'Needs non-empty body and a valid diff location. --start-line/--start-side must be supplied together; old-SHA comments may be outdated.',
    async (ctx, opts) => {
      const text = await readBody(opts, true);

      if (
        (opts['start-line'] === undefined) !== (opts['start-side'] === undefined) ||
        opts['start-line'] > opts.line
      ) {
        throw usage(
          'Multi-line comments require --start-line <= --line and --start-side together.',
        );
      }

      return ctx.single('POST /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
        pull_number: opts.number,
        body: text,
        path: opts.path,
        line: opts.line,
        side: opts.side,
        start_line: opts['start-line'],
        start_side: opts['start-side'],
        commit_id: await reviewedSha(ctx, opts),
      });
    },
  ),
  command(
    'review-comment-reply',
    group,
    'Reply within an existing inline review thread.',
    { ...number, ...commentId, ...body },
    ['number', 'comment-id'],
    'review-comment-reply --repo any-skill/github --number 123 --comment-id 456 --body "Fixed in the latest commit"',
    commentResult,
    'Needs non-empty body. If the supplied comment is already a reply, its root inReplyToId is used because GitHub only accepts replies to the root.',
    async (ctx, opts) => {
      const text = await readBody(opts, true);
      const current = await getComment(ctx, opts);

      return ctx.single(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies',
        {
          pull_number: opts.number,
          comment_id: current.data.inReplyToId ?? opts['comment-id'],
          body: text,
        },
      );
    },
  ),
  command(
    'review-comment-update',
    group,
    'Edit an inline review comment.',
    { ...number, ...commentId, ...body },
    ['number', 'comment-id'],
    'review-comment-update --repo any-skill/github --number 123 --comment-id 456 --body "Clarified feedback"',
    commentResult,
    'Needs non-empty body and ownership or sufficient GitHub permission. The PR association is checked before writing.',
    async (ctx, opts) => {
      const text = await readBody(opts, true);

      await getComment(ctx, opts);

      return ctx.single('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
        comment_id: opts['comment-id'],
        body: text,
      });
    },
  ),
];
