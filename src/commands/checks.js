import { command, string, integer, number, ref, restPaging, conditional } from '../options.js';
import { CliError } from '../errors.js';
import { concurrently } from '../client.js';
import { getPull } from './pulls.js';

const group = 'Checks / CI';
const NEWLINE = 0x0a;
// Precedence of the combined state after failures: activity, then uncertainty, then success.
const STATE_PRECEDENCE = ['running', 'pending', 'unknown', 'successful'];
const runId = { 'run-id': integer('GitHub Actions workflow run ID.') };
const jobId = { 'job-id': integer('GitHub Actions job ID.') };
const checkId = { 'check-id': integer('Check run ID.') };
const suiteId = { 'suite-id': integer('Check suite ID.') };
const resource =
  'data: GitHub CI resource with camelCase keys, IDs, status/conclusion, SHAs and available timestamps.';
const resources = 'data: CI resource array; meta.pagination describes remaining pages.';

export function checkCategory(item) {
  const state = item.state ?? item.status;
  const conclusion = item.conclusion;

  if (
    ['failure', 'error'].includes(state) ||
    ['failure', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(conclusion)
  ) {
    return 'failed';
  }
  if (conclusion === 'cancelled') {
    return 'cancelled';
  }
  if (state === 'in_progress') {
    return 'running';
  }
  if (['pending', 'queued', 'waiting', 'requested', 'pending_deployment'].includes(state)) {
    return 'pending';
  }
  if (state === 'success' || conclusion === 'success') {
    return 'successful';
  }
  if (['neutral', 'skipped'].includes(conclusion)) {
    return 'neutral';
  }

  return 'unknown';
}

export function summarizeChecks(statuses, checks) {
  const latest = new Map();

  for (const entry of statuses) {
    const previous = latest.get(entry.context);

    if (
      !previous ||
      Date.parse(entry.updatedAt ?? entry.createdAt) >
        Date.parse(previous.updatedAt ?? previous.createdAt)
    ) {
      latest.set(entry.context, entry);
    }
  }

  const items = [...latest.values()]
    .map((entry) => ({ type: 'commit-status', ...entry, category: checkCategory(entry) }))
    .concat(
      checks.map((entry) => ({ type: 'check-run', ...entry, category: checkCategory(entry) })),
    );
  const categories = new Set(items.map((entry) => entry.category));
  let state;

  if (!categories.size) {
    state = 'no-checks';
  } else if (categories.has('failed') || categories.has('cancelled')) {
    state = 'failed';
  } else {
    state = STATE_PRECEDENCE.find((value) => categories.has(value)) ?? 'neutral';
  }

  return { state, items };
}

// Stops at the byte limit or at the end of the last requested line, so a short read does not
// download the whole log. UTF-8 never uses a 0x0a byte inside another character, so lines
// can be counted on raw bytes.
export async function readLogLines(body, maxBytes, maxLines) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  let lines = 0;
  let complete = false;
  let truncated = false;

  try {
    while (!truncated) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }
      if (complete) {
        truncated = value.length > 0;
        continue;
      }

      let end = Math.min(value.length, maxBytes - size);

      for (
        let index = value.indexOf(NEWLINE);
        index !== -1 && index < end;
        index = value.indexOf(NEWLINE, index + 1)
      ) {
        if (++lines === maxLines) {
          end = index + 1;
          complete = true;
          break;
        }
      }
      chunks.push(value.subarray(0, end));
      size += end;
      truncated = value.length > end;
    }
    if (truncated) {
      await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks, size);
  // A log ending exactly at the line limit is returned whole. Otherwise omit the newline
  // that ended the last returned line.
  const text = new TextDecoder('utf-8').decode(
    complete && truncated ? bytes.subarray(0, -1) : bytes,
    { stream: truncated },
  );
  const returnedLines = text.split('\n').length - (!text || text.endsWith('\n') ? 1 : 0);

  return { text, truncated, returnedLines };
}

async function jobLogs(ctx, opts) {
  const response = await ctx.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
    job_id: opts['job-id'],
    request: { redirect: 'manual', parseSuccessResponseBody: false },
  });
  const location = response.headers.location;

  if (!location || new URL(location).protocol !== 'https:') {
    throw new CliError(
      'INVALID_RESPONSE',
      'GitHub did not return an HTTPS job log download location.',
    );
  }

  // The signed download URL is never printed or persisted; do not forward the API token.
  const download = await fetch(location, {
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeout),
  });

  if (!download.ok || !download.body) {
    throw new CliError('LOG_DOWNLOAD_FAILED', `Job log download returned HTTP ${download.status}.`);
  }

  const log = await readLogLines(download.body, opts['max-bytes'], opts['max-lines']);

  return { data: { jobId: opts['job-id'], ...log }, meta: {} };
}

export const checkCommands = [
  command(
    'status-get',
    group,
    'Read the combined commit status and one page of latest status contexts.',
    { ...ref, page: restPaging.page, 'per-page': restPaging['per-page'], ...conditional },
    ['ref'],
    'status-get --repo any-skill/github --ref main',
    'data: {state, statuses, sha, totalCount, ...}; meta.pagination is present when GitHub supplies continuation.',
    'Commit statuses exclude check runs. Use status-list for history and pr-checks for the combined view.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/commits/{ref}/status', {
        ref: opts.ref,
        page: opts.page,
        per_page: opts['per-page'],
      }),
  ),
  command(
    'status-list',
    group,
    'Read commit status history.',
    { ...ref, ...restPaging },
    ['ref'],
    'status-list --repo any-skill/github --ref main --all',
    resources,
    'Multiple entries may share a context. Compare timestamps/IDs and use the newest status per context.',
    (ctx, opts) => ctx.list('GET /repos/{owner}/{repo}/commits/{ref}/statuses', { ref: opts.ref }),
  ),
  command(
    'check-run-list',
    group,
    'Read check runs for a ref.',
    {
      ...ref,
      ...restPaging,
      name: string('Exact check name.'),
      filter: string('Latest runs or all runs.', { choices: ['latest', 'all'], default: 'latest' }),
    },
    ['ref'],
    'check-run-list --repo any-skill/github --ref main --all',
    resources,
    'A running check has no final conclusion. Latest filtering is performed by GitHub.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        ref: opts.ref,
        check_name: opts.name,
        filter: opts.filter,
      }),
  ),
  command(
    'check-run-get',
    group,
    'Read a check run and its failure summary/details URL.',
    { ...checkId, ...conditional },
    ['check-id'],
    'check-run-get --repo any-skill/github --check-id 456',
    resource,
    'External CI detailsUrl is returned but never fetched using GitHub credentials.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/check-runs/{check_run_id}', {
        check_run_id: opts['check-id'],
      }),
  ),
  command(
    'check-run-annotations',
    group,
    'Read file-level annotations for a check run.',
    { ...checkId, ...restPaging },
    ['check-id'],
    'check-run-annotations --repo any-skill/github --check-id 456 --all',
    resources,
    'Annotations can identify failure locations without access to an external CI provider.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
        check_run_id: opts['check-id'],
      }),
  ),
  command(
    'check-suite-list',
    group,
    'Read check suites for a ref.',
    { ...ref, ...restPaging },
    ['ref'],
    'check-suite-list --repo any-skill/github --ref main --all',
    resources,
    'A suite conclusion does not replace checking its individual runs.',
    (ctx, opts) =>
      ctx.list('GET /repos/{owner}/{repo}/commits/{ref}/check-suites', { ref: opts.ref }),
  ),
  command(
    'check-suite-get',
    group,
    'Read one check suite.',
    { ...suiteId, ...conditional },
    ['suite-id'],
    'check-suite-get --repo any-skill/github --suite-id 456',
    resource,
    'status and conclusion can change while the suite is running.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/check-suites/{check_suite_id}', {
        check_suite_id: opts['suite-id'],
      }),
  ),
  command(
    'workflow-run-list',
    group,
    'Read GitHub Actions workflow runs.',
    {
      ...restPaging,
      branch: string('Head branch.'),
      event: string('Workflow event.'),
      'head-sha': string('Filter runs by head SHA.'),
      created: string('GitHub created-date search range, e.g. >=2026-01-01.'),
      status: string('GitHub run status or conclusion filter.'),
    },
    [],
    'workflow-run-list --repo any-skill/github --branch main --status failure --all',
    resources,
    'Filtered workflow-run searches can be capped at 1000 results. Narrow created ranges; runAttempt distinguishes reruns.',
    async (ctx, opts) => {
      const result = await ctx.list('GET /repos/{owner}/{repo}/actions/runs', {
        branch: opts.branch,
        event: opts.event,
        head_sha: opts['head-sha'],
        created: opts.created,
        status: opts.status,
      });

      if (
        result.meta.pagination.totalCount > 1000 &&
        (opts.branch || opts.event || opts.created || opts.status || opts['head-sha'])
      ) {
        result.meta.pagination.apiLimit = 1000;
        result.meta.pagination.complete = false;
      }

      return result;
    },
  ),
  command(
    'workflow-run-get',
    group,
    'Read a workflow run including attempt and head SHA.',
    { ...runId, ...conditional },
    ['run-id'],
    'workflow-run-get --repo any-skill/github --run-id 456',
    resource,
    'A completed run can be successful, failed, cancelled or skipped; inspect conclusion.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: opts['run-id'] }),
  ),
  command(
    'workflow-job-list',
    group,
    'Read jobs for a workflow run or a specific rerun attempt.',
    {
      ...runId,
      ...restPaging,
      attempt: integer('Specific run attempt; otherwise GitHub returns latest jobs.'),
    },
    ['run-id'],
    'workflow-job-list --repo any-skill/github --run-id 456 --all',
    resources,
    'Use the runAttempt from workflow-run-get to select an exact attempt.',
    (ctx, opts) =>
      ctx.list(
        opts.attempt
          ? 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs'
          : 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
        {
          run_id: opts['run-id'],
          attempt_number: opts.attempt,
        },
      ),
  ),
  command(
    'workflow-job-get',
    group,
    'Read a job and its step status/conclusions.',
    { ...jobId, ...conditional },
    ['job-id'],
    'workflow-job-get --repo any-skill/github --job-id 456',
    resource,
    'Logs may not yet be available for running jobs, or may have expired.',
    (ctx, opts) =>
      ctx.single('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', { job_id: opts['job-id'] }),
  ),
  command(
    'workflow-job-logs',
    group,
    'Read a bounded plain-text job log inside JSON.',
    {
      ...jobId,
      'max-bytes': integer('Maximum downloaded log bytes.', { default: '1048576', max: 10485760 }),
      'max-lines': integer('Maximum returned log lines.', { default: '200', max: 10000 }),
    },
    ['job-id'],
    'workflow-job-logs --repo any-skill/github --job-id 456 --max-lines 200',
    'data: {jobId, text, truncated, returnedLines}; no signed download URL is exposed.',
    'Requires Actions read permission. Logs can be unavailable/expired. This returns the first bounded lines, not an automatic failure classifier; truncated=true means incomplete logs.',
    jobLogs,
  ),
  command(
    'pr-checks',
    group,
    'Read commit statuses and latest check runs for the observed PR head.',
    number,
    ['number'],
    'pr-checks --repo any-skill/github --number 123',
    'data: {number, headSha, state, items}; state is no-checks|pending|running|successful|failed|neutral|unknown.',
    'Reads every status/check page. Each item retains provider status/conclusion. A failed check is data and exits 0; no-checks/neutral is not approval or proof of merge readiness.',
    async (ctx, opts) => {
      const current = await getPull(ctx, opts.number);
      const headSha = current.data.head.sha;
      const paged = ctx.withOptions({ all: true, page: 1, 'per-page': 100 });
      const [statuses, checks] = await concurrently(
        paged.list('GET /repos/{owner}/{repo}/commits/{ref}/statuses', { ref: headSha }),
        paged.list('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
          ref: headSha,
          filter: 'latest',
        }),
      );

      return {
        data: {
          number: opts.number,
          headSha,
          ...summarizeChecks(statuses.data, checks.data),
        },
        meta: { rateLimit: checks.meta.rateLimit },
      };
    },
  ),
];
