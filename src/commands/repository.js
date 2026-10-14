import { command, string, restPaging, conditional, ref, since } from '../options.js';

const group = 'Repository Information';
const objectResult = 'data: GitHub resource object with camelCase keys.';
const listResult = 'data: resource array; meta.pagination describes remaining pages.';

export const repositoryCommands = [
  command(
    'repo-get',
    group,
    'Read repository metadata, permissions and default branch.',
    conditional,
    [],
    'repo-get --repo any-skill/github',
    objectResult,
    'A private or inaccessible repository can return 404.',
    (ctx) => ctx.single('GET /repos/{owner}/{repo}'),
  ),
  command(
    'branch-list',
    group,
    'List repository branches.',
    { ...restPaging },
    [],
    'branch-list --repo any-skill/github --all',
    listResult,
    'The protected field describes branch protection, not permission to bypass it.',
    (ctx) => ctx.list('GET /repos/{owner}/{repo}/branches'),
  ),
  command(
    'branch-get',
    group,
    'Read a branch and its current commit.',
    { branch: string('Branch name.'), ...conditional },
    ['branch'],
    'branch-get --repo any-skill/github --branch main',
    objectResult,
    'Branch names are passed as encoded API parameters.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/branches/{branch}', { branch: opts.branch }),
  ),
  command(
    'commit-list',
    group,
    'List commits reachable from a ref.',
    {
      ...restPaging,
      ...ref,
      ...since,
      until: string('ISO 8601 upper timestamp.', { timestamp: true }),
      path: string('Filter by repository-relative file path.'),
      author: string('GitHub login or commit author email.'),
    },
    [],
    'commit-list --repo any-skill/github --ref main --per-page 10',
    listResult,
    '--since/--until are API commit-date filters, not a complete change-event stream.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/commits', {
        sha: opts.ref,
        since: opts.since,
        until: opts.until,
        path: opts.path,
        author: opts.author,
      }),
  ),
  command(
    'commit-get',
    group,
    'Read commit metadata, statistics and one page of changed files.',
    { ...ref, ...conditional, page: restPaging.page, 'per-page': restPaging['per-page'] },
    ['ref'],
    'commit-get --repo any-skill/github --ref main',
    objectResult,
    'Large commits paginate files via --page. GitHub caps files at 3000 and may omit binary/large patches. See meta.pagination.',
    async (ctx, opts) => {
      const result = await ctx.single('GET /repos/{owner}/{repo}/commits/{ref}', {
        ref: opts.ref,
        page: opts.page,
        per_page: opts['per-page'],
      });

      if (result.data) {
        const hasNextPage = result.meta.pagination?.hasNextPage ?? false;

        result.meta.pagination = {
          page: opts.page,
          perPage: opts['per-page'],
          hasNextPage,
          nextPage: hasNextPage ? opts.page + 1 : null,
          complete:
            !hasNextPage &&
            (opts.page - 1) * opts['per-page'] + (result.data.files?.length ?? 0) < 3000,
        };
      }

      return result;
    },
  ),
  command(
    'label-list',
    group,
    'List labels available for issue and PR metadata.',
    restPaging,
    [],
    'label-list --repo any-skill/github --all',
    listResult,
    'This command reads existing labels and does not create them.',
    (ctx) => ctx.list('GET /repos/{owner}/{repo}/labels'),
  ),
  command(
    'milestone-list',
    group,
    'List repository milestones.',
    {
      ...restPaging,
      state: string('Milestone state.', { choices: ['open', 'closed', 'all'], default: 'open' }),
    },
    [],
    'milestone-list --repo any-skill/github --state all',
    listResult,
    'Issue updates use milestone.number, not milestone.id.',
    (ctx, opts) => ctx.list('GET /repos/{owner}/{repo}/milestones', { state: opts.state }),
  ),
];
