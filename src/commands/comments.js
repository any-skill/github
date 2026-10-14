import { command, number, commentId, body, restPaging, since, conditional } from '../options.js';
import { readBody } from '../input.js';
import { ensureIssue } from './issues.js';
import { getPull } from './pulls.js';
import { usage } from '../errors.js';
import { concurrently } from '../client.js';

async function ensureParent(ctx, opts, kind) {
  if (kind === 'issue') {
    await ensureIssue(ctx, opts.number);
  } else {
    await getPull(ctx, opts.number);
  }
}

async function ensureComment(ctx, opts, kind) {
  const [, result] = await concurrently(
    ensureParent(ctx, opts, kind),
    ctx.single('GET /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      comment_id: opts['comment-id'],
    }),
  );
  const parent = result.data.issueUrl?.match(/\/issues\/(\d+)$/)?.[1];

  if (Number(parent) !== opts.number) {
    throw usage('Comment does not belong to the selected issue or pull request.');
  }

  return result;
}

export const commentCommands = ['issue', 'pr'].flatMap((kind) => {
  const group = kind === 'issue' ? 'Issue Comments' : 'PR Comments';
  const result =
    'data: conversation comment object/array with numeric id, nodeId, body, createdAt, updatedAt and user.';

  return [
    command(
      `${kind}-comment-list`,
      group,
      `Read ${kind === 'pr' ? 'PR conversation' : 'issue'} comments.`,
      { ...number, ...restPaging, ...since },
      ['number'],
      `${kind}-comment-list --repo any-skill/github --number 123 --all`,
      result,
      '--since is applied locally to updatedAt after API paging; it does not reduce API requests. PR inline feedback uses review-comment-*.',
      async (ctx, opts) => {
        await ensureParent(ctx, opts, kind);

        return ctx.list(
          'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
          { issue_number: opts.number },
          (entry) => !opts.since || Date.parse(entry.updated_at) > Date.parse(opts.since),
        );
      },
    ),
    command(
      `${kind}-comment-get`,
      group,
      'Read a conversation comment and verify its parent.',
      { ...number, ...commentId },
      ['number', 'comment-id'],
      `${kind}-comment-get --repo any-skill/github --number 123 --comment-id 456`,
      result,
      'Both the parent number and comment ID are required to prevent targeting another resource.',
      (ctx, opts) => ensureComment(ctx, opts, kind),
    ),
    command(
      `${kind}-comment-create`,
      group,
      'Add a conversation comment.',
      { ...number, ...body },
      ['number'],
      `${kind}-comment-create --repo any-skill/github --number 123 --body "Additional context"`,
      result,
      'Requires non-empty --body or --body-file. Check for an existing equivalent comment before retrying.',
      async (ctx, opts) => {
        const text = await readBody(opts, true);

        await ensureParent(ctx, opts, kind);

        return ctx.single('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          issue_number: opts.number,
          body: text,
        });
      },
    ),
    command(
      `${kind}-comment-update`,
      group,
      'Edit a conversation comment.',
      { ...number, ...commentId, ...body },
      ['number', 'comment-id'],
      `${kind}-comment-update --repo any-skill/github --number 123 --comment-id 456 --body "Corrected context"`,
      result,
      'Requires non-empty body and ownership or sufficient GitHub permissions; the parent is checked before writing.',
      async (ctx, opts) => {
        const text = await readBody(opts, true);

        await ensureComment(ctx, opts, kind);

        return ctx.single('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
          comment_id: opts['comment-id'],
          body: text,
        });
      },
    ),
  ];
});

commentCommands.push(
  command(
    'repo-comment-list',
    'Issue Comments',
    'Read changed conversation comments across a repository, including issues and PRs.',
    { ...restPaging, ...since, ...conditional },
    [],
    'repo-comment-list --repo any-skill/github --since 2026-01-01T00:00:00Z --all',
    'data: comment array; issueUrl identifies the parent number. Resource kind is not inferred.',
    '--since is a native updated-time filter. GitHub uses the same endpoint for issue and PR conversation comments.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/issues/comments', {
        since: opts.since,
        sort: 'updated',
        direction: 'asc',
      }),
  ),
);
