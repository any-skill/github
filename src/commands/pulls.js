import { command, string, integer, number, body, restPaging, since, sorting } from '../options.js';
import { readBody, requireChanges } from '../input.js';
import { CliError, expectObject } from '../errors.js';
import { concurrently } from '../client.js';
import { search } from './issues.js';

const group = 'Pull Requests';
const resultObject =
  'data: PR object with id, nodeId, number, state, mergedAt, head/base refs and SHAs.';
const statusQuery = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) { reviewDecision mergeStateStatus mergeable }
  }
}`;

export async function getPull(ctx, pullNumber) {
  return ctx.single('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
}

async function setDraft(ctx, opts, draft) {
  const current = await getPull(ctx, opts.number);
  const operation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
  const data = await ctx.graph(
    `mutation($id: ID!) {
    ${operation}(input: {pullRequestId: $id}) { pullRequest { id number isDraft url } }
  }`,
    { id: current.data.nodeId },
  );

  return { data: expectObject(data[operation]?.pullRequest), meta: {} };
}

export const pullCommands = [
  command(
    'pr-list',
    group,
    'List pull requests, including closed or merged results when requested.',
    {
      ...restPaging,
      ...since,
      state: string('PR state; merged is filtered from closed PRs.', {
        choices: ['open', 'closed', 'merged', 'all'],
        default: 'open',
      }),
      head: string('Head filter owner:branch. Supply this to find an existing branch PR.'),
      base: string('Target branch filter.'),
      sort: string('PR sort field.', {
        choices: ['created', 'updated', 'popularity', 'long-running'],
        default: 'created',
      }),
      direction: sorting.direction,
    },
    [],
    'pr-list --repo any-skill/github --head any-skill:feature --state open --all',
    'data: PR array; meta.pagination describes the fetched window.',
    '--since filters updatedAt locally after paging, not a native PR filter. For author/labels or indexed date search, use pr-search.',
    (ctx, opts) =>
      ctx.list(
        'GET /repos/{owner}/{repo}/pulls',
        {
          state: opts.state === 'merged' ? 'closed' : opts.state,
          head: opts.head,
          base: opts.base,
          sort: opts.sort,
          direction: opts.direction,
        },
        (entry) =>
          (opts.state !== 'merged' || entry.merged_at !== null) &&
          (!opts.since || Date.parse(entry.updated_at) > Date.parse(opts.since)),
      ),
  ),
  command(
    'pr-search',
    group,
    'Search pull requests within the selected repository.',
    { ...restPaging, ...sorting, query: string('Quoted GitHub search expression.') },
    ['query'],
    'pr-search --repo any-skill/github --query "is:open author:octocat updated:>=2026-01-01"',
    'data: search issue-shaped PR array. Read pr-get for full PR metadata.',
    'The CLI adds repo and is:pr. Search can lag and is limited to 1000 results; narrow queries instead of assuming completeness.',
    (ctx, opts) => search(ctx, opts, 'pr'),
  ),
  command(
    'pr-get',
    group,
    'Read PR metadata and GitHub-calculated review and merge states.',
    number,
    ['number'],
    'pr-get --repo any-skill/github --number 123',
    `${resultObject} Also includes reviewDecision, mergeStateStatus and graphqlMergeable.`,
    'Uses REST plus GraphQL. Mergeability can be unknown/null while GitHub computes it. Approval, CI and mergeability are separate.',
    async (ctx, opts) => {
      const [current, data] = await concurrently(
        getPull(ctx, opts.number),
        ctx.graph(statusQuery, { number: opts.number }),
      );
      const status = data.repository?.pullRequest;

      if (!status) {
        throw new CliError('NOT_FOUND', 'Pull request not found or not visible.', 5);
      }

      return {
        ...current,
        data: {
          ...current.data,
          reviewDecision: status.reviewDecision,
          mergeStateStatus: status.mergeStateStatus,
          graphqlMergeable: status.mergeable,
        },
      };
    },
  ),
  command(
    'pr-create',
    group,
    'Create a PR after checking for an open PR for the head branch.',
    {
      title: string('PR title.'),
      head: string('Source branch, optionally owner:branch.'),
      base: string('Target branch.'),
      ...body,
      draft: { type: 'boolean', description: 'Create as draft.' },
    },
    ['title', 'head', 'base'],
    'pr-create --repo any-skill/github --head feature --base main --title "Fix startup" --body "Summary" --draft',
    resultObject,
    'Push with Git first. An existing open PR returns ALREADY_EXISTS with its number/URL. Preflight cannot eliminate concurrent-create races.',
    async (ctx, opts) => {
      const text = await readBody(opts);
      const head = opts.head.includes(':') ? opts.head : `${ctx.repository.owner}:${opts.head}`;
      const existing = await ctx.request('GET /repos/{owner}/{repo}/pulls', {
        head,
        state: 'open',
        per_page: 1,
      });

      if (!Array.isArray(existing.data)) {
        throw new CliError('INVALID_RESPONSE', 'Expected an array of existing pull requests.');
      }
      if (existing.data.length) {
        throw new CliError('ALREADY_EXISTS', 'An open PR already exists for this head branch.', 8, {
          number: existing.data[0].number,
          url: existing.data[0].html_url,
        });
      }

      return ctx.single('POST /repos/{owner}/{repo}/pulls', {
        title: opts.title,
        head: opts.head,
        base: opts.base,
        body: text,
        draft: opts.draft ?? false,
      });
    },
  ),
  command(
    'pr-update',
    group,
    'Update explicitly supplied PR fields.',
    {
      ...number,
      title: string('New title.'),
      ...body,
      base: string('New target branch.'),
      state: string('Explicitly change PR state.', { choices: ['open', 'closed'] }),
    },
    ['number'],
    'pr-update --repo any-skill/github --number 123 --title "Updated summary"',
    resultObject,
    'Supply at least one changed field. --state closed requires an explicit assignment to close the PR. This command never merges.',
    async (ctx, opts) => {
      const fields = {
        title: opts.title,
        body: await readBody(opts),
        base: opts.base,
        state: opts.state,
      };

      requireChanges(fields);

      // The pulls endpoint only accepts PR numbers, so no type preflight is needed.
      return ctx.single('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', {
        pull_number: opts.number,
        ...fields,
      });
    },
  ),
  command(
    'pr-draft',
    group,
    'Convert a PR to draft.',
    number,
    ['number'],
    'pr-draft --repo any-skill/github --number 123',
    'data: {id, number, isDraft, url}; id is the GraphQL node ID.',
    'GitHub permissions and repository capabilities apply.',
    (ctx, opts) => setDraft(ctx, opts, true),
  ),
  command(
    'pr-ready',
    group,
    'Mark a draft PR ready for review.',
    number,
    ['number'],
    'pr-ready --repo any-skill/github --number 123',
    'data: {id, number, isDraft, url}; id is the GraphQL node ID.',
    'This can notify reviewers. Use only within the assigned task.',
    (ctx, opts) => setDraft(ctx, opts, false),
  ),
  command(
    'pr-commits',
    group,
    'Read PR commits.',
    { ...number, ...restPaging },
    ['number'],
    'pr-commits --repo any-skill/github --number 123 --all',
    'data: commit array containing sha; meta.pagination includes the API limit when reached.',
    'GitHub returns at most 250 PR commits. Use standard Git for complete history beyond this cap.',
    async (ctx, opts) => {
      const result = await ctx.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        pull_number: opts.number,
      });

      if ((opts.page - 1) * opts['per-page'] + result.data.length >= 250) {
        result.meta.pagination.apiLimit = 250;
        result.meta.pagination.complete = false;
      }

      return result;
    },
  ),
  command(
    'pr-files',
    group,
    'Read changed PR files and available patches.',
    { ...number, ...restPaging },
    ['number'],
    'pr-files --repo any-skill/github --number 123 --all',
    'data: changed-file array; meta.pagination.totalCount is PR changedFiles.',
    'GitHub caps files at 3000. Binary/large file patches can be absent; use local Git for complete source/diff.',
    async (ctx, opts) => {
      const [current, result] = await concurrently(
        getPull(ctx, opts.number),
        ctx.list('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
          pull_number: opts.number,
        }),
      );

      result.meta.pagination.totalCount = current.data.changedFiles;
      if (current.data.changedFiles > 3000) {
        result.meta.pagination.apiLimit = 3000;
        result.meta.pagination.complete = false;
      }

      return result;
    },
  ),
  command(
    'pr-diff',
    group,
    'Read the PR unified diff inside JSON.',
    {
      ...number,
      'max-bytes': integer('Maximum returned UTF-8 bytes.', { default: '1048576', max: 10485760 }),
    },
    ['number'],
    'pr-diff --repo any-skill/github --number 123 --max-bytes 1048576',
    'data: {diff, truncated, returnedBytes}; diff is a string, never raw stdout.',
    'GitHub can reject oversized diffs. truncated=true means the returned diff is incomplete; use Git for the complete diff.',
    async (ctx, opts) => {
      const response = await ctx.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        pull_number: opts.number,
        headers: { accept: 'application/vnd.github.diff' },
      });

      if (typeof response.data !== 'string') {
        throw new CliError('INVALID_RESPONSE', 'Expected a text diff.');
      }

      const bytes = Buffer.from(response.data);
      const limited = bytes.subarray(0, opts['max-bytes']);
      const diff = new TextDecoder('utf-8').decode(limited, {
        stream: bytes.length > limited.length,
      });

      return {
        data: {
          diff,
          truncated: bytes.length > limited.length,
          returnedBytes: Buffer.byteLength(diff),
        },
        meta: {},
      };
    },
  ),
];
