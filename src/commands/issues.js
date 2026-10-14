import { command, string, integer, number, body, restPaging, since, sorting } from '../options.js';
import { readBody, requireChanges } from '../input.js';
import { usage } from '../errors.js';

const group = 'Issues';
const objectResult =
  'data: Issue object including id, nodeId, number, state, createdAt and updatedAt.';
const listResult = 'data: Issue array; meta.pagination contains continuation and completeness.';
const labelOptions = {
  label: string('Label name; repeat for multiple labels.', { multiple: true }),
  assignee: string('Assignee login; repeat for multiple assignees.', { multiple: true }),
  milestone: integer('Milestone number (0 removes it on update).', { min: 0 }),
};

export function issueOnly(data) {
  return !Object.hasOwn(data, 'pull_request');
}

export async function ensureIssue(ctx, issueNumber) {
  const result = await ctx.single('GET /repos/{owner}/{repo}/issues/{issue_number}', {
    issue_number: issueNumber,
  });

  if (result.data.pullRequest) {
    throw usage('This number belongs to a pull request. Use a pr-* command.');
  }

  return result;
}

async function updateIssue(ctx, opts, forcedState) {
  const fields = {
    title: opts.title,
    body: await readBody(opts),
    state: forcedState,
    labels: opts.label,
    assignees: opts.assignee,
    milestone: opts.milestone === 0 ? null : opts.milestone,
  };

  requireChanges(fields);
  await ensureIssue(ctx, opts.number);

  return ctx.single('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
    issue_number: opts.number,
    ...fields,
  });
}

export const issueCommands = [
  command(
    'issue-list',
    group,
    'List actual issues, excluding pull requests.',
    {
      ...restPaging,
      ...since,
      ...sorting,
      state: string('Issue state.', { choices: ['open', 'closed', 'all'], default: 'open' }),
      label: labelOptions.label,
      author: string('Issue creator login.'),
      assignee: string('Assignee login, * for any, or none.'),
      milestone: string('Milestone number, * for any, or none.'),
    },
    [],
    'issue-list --repo any-skill/github --state all --sort updated --since 2026-01-01T00:00:00Z --all',
    listResult,
    '--since is a native updated-time filter. Labels are ANDed. Pagination totals may include PRs before filtering.',
    (ctx, opts) =>
      ctx.list(
        'GET /repos/{owner}/{repo}/issues',
        {
          state: opts.state,
          since: opts.since,
          sort: opts.sort,
          direction: opts.direction,
          labels: opts.label?.join(','),
          creator: opts.author,
          assignee: opts.assignee,
          milestone: opts.milestone,
        },
        issueOnly,
      ),
  ),
  command(
    'issue-search',
    group,
    'Search the GitHub issue index within the selected repository.',
    {
      ...restPaging,
      query: string('GitHub search expression; quote it as one value.'),
      ...sorting,
    },
    ['query'],
    'issue-search --repo any-skill/github --query "is:open label:bug updated:>=2026-01-01"',
    listResult,
    'The CLI enforces repo and is:issue. Search is indexed, may lag, and has a 1000-result cap. Narrow time windows for polling.',
    (ctx, opts) => search(ctx, opts, 'issue'),
  ),
  command(
    'issue-get',
    group,
    'Read one issue.',
    { ...number },
    ['number'],
    'issue-get --repo any-skill/github --number 123',
    objectResult,
    'Does not implicitly fetch comments. A PR number is rejected.',
    (ctx, opts) => ensureIssue(ctx, opts.number),
  ),
  command(
    'issue-create',
    group,
    'Create an issue.',
    { title: string('Non-empty issue title.'), ...body, ...labelOptions },
    ['title'],
    'issue-create --repo any-skill/github --title "Fix startup" --body "Steps to reproduce"',
    objectResult,
    'Check existing issues first. Unknown labels/assignees and insufficient permissions can fail or be ignored by GitHub; inspect returned metadata.',
    async (ctx, opts) =>
      ctx.single('POST /repos/{owner}/{repo}/issues', {
        title: opts.title,
        body: await readBody(opts),
        labels: opts.label,
        assignees: opts.assignee,
        milestone: opts.milestone,
      }),
  ),
  command(
    'issue-update',
    group,
    'Update explicitly supplied issue fields.',
    {
      ...number,
      title: string('New title.'),
      ...body,
      ...labelOptions,
      'clear-labels': { type: 'boolean', description: 'Replace labels with an empty array.' },
      'clear-assignees': { type: 'boolean', description: 'Replace assignees with an empty array.' },
    },
    ['number'],
    'issue-update --repo any-skill/github --number 123 --label bug --assignee octocat',
    objectResult,
    '--label/--assignee replace the entire corresponding collection; read the current state first. Clear flags conflict with their repeated options.',
    (ctx, opts) => {
      if ((opts['clear-labels'] && opts.label) || (opts['clear-assignees'] && opts.assignee)) {
        throw usage('Do not combine a clear flag with its collection option.');
      }

      return updateIssue(ctx, {
        ...opts,
        label: opts['clear-labels'] ? [] : opts.label,
        assignee: opts['clear-assignees'] ? [] : opts.assignee,
      });
    },
  ),
  command(
    'issue-close',
    group,
    'Close an issue after checking its current resource type.',
    number,
    ['number'],
    'issue-close --repo any-skill/github --number 123',
    objectResult,
    'Use only when explicitly assigned to close the issue.',
    (ctx, opts) => updateIssue(ctx, opts, 'closed'),
  ),
  command(
    'issue-reopen',
    group,
    'Reopen an issue.',
    number,
    ['number'],
    'issue-reopen --repo any-skill/github --number 123',
    objectResult,
    'Requires write permission; does not reopen pull requests.',
    (ctx, opts) => updateIssue(ctx, opts, 'open'),
  ),
];

export async function search(ctx, opts, type) {
  if (/\b(?:repo|org|user):|(?:^|[\s(+-])(?:is|type):(issue|pr)\b/i.test(opts.query)) {
    throw usage('Do not supply repo/org/user or issue/PR type qualifiers; the CLI adds those.');
  }

  const result = await ctx.list(
    'GET /search/issues',
    {
      q: `repo:${ctx.repository.fullName} is:${type} (${opts.query})`,
      sort: opts.sort,
      order: opts.direction,
    },
    (entry) =>
      entry.repository_url?.toLowerCase() ===
        `https://api.github.com/repos/${ctx.repository.fullName}`.toLowerCase() &&
      (type === 'issue' ? issueOnly(entry) : !issueOnly(entry)),
  );

  if (result.meta.pagination?.totalCount > 1000) {
    result.meta.pagination.complete = false;
    result.meta.pagination.apiLimit = 1000;
  }

  return result;
}
