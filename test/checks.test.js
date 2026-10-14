import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { checkCategory, readLogLines, summarizeChecks } from '../src/commands/checks.js';
import { httpMock, invoke } from './helpers.js';

test('CI categories distinguish pending, running, failed, successful and unknown', () => {
  assert.equal(checkCategory({ status: 'queued' }), 'pending');
  assert.equal(checkCategory({ status: 'in_progress', conclusion: null }), 'running');
  assert.equal(checkCategory({ status: 'completed', conclusion: 'failure' }), 'failed');
  assert.equal(checkCategory({ status: 'completed', conclusion: 'success' }), 'successful');
  assert.equal(checkCategory({ status: 'completed', conclusion: null }), 'unknown');
  assert.equal(summarizeChecks([], []).state, 'no-checks');
  assert.equal(summarizeChecks([], [{ conclusion: 'skipped' }]).state, 'neutral');
});

test('status history only contributes the latest decision for each context', () => {
  const result = summarizeChecks(
    [
      { context: 'ci', state: 'failure', updatedAt: '2026-01-01T00:00:00Z' },
      { context: 'ci', state: 'success', updatedAt: '2026-01-02T00:00:00Z' },
    ],
    [],
  );

  assert.equal(result.state, 'successful');
  assert.equal(result.items.length, 1);
});

test('pr-checks reads statuses and check runs at the observed SHA and exits 0 for CI failure', async () => {
  const mock = httpMock([
    { path: '/repos/owner/repo/pulls/123', data: { number: 123, head: { sha: 'fixed-sha' } } },
    {
      path: '/repos/owner/repo/commits/fixed-sha/statuses',
      query: { per_page: 100 },
      data: [{ context: 'status', state: 'pending', updated_at: '2026-01-01T00:00:00Z' }],
    },
    {
      path: '/repos/owner/repo/commits/fixed-sha/check-runs',
      query: { filter: 'latest' },
      data: { total_count: 1, check_runs: [{ id: 1, status: 'completed', conclusion: 'failure' }] },
    },
  ]);
  const result = await invoke(['pr-checks', '--repo', 'owner/repo', '--number', '123'], mock);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data.headSha, 'fixed-sha');
  assert.equal(result.output.data.state, 'failed');
  assert.equal(result.output.data.items.length, 2);
  mock.done();
});

test('workflow jobs select the exact rerun attempt and unwrap GitHub response arrays', async () => {
  const mock = httpMock([
    {
      path: '/repos/owner/repo/actions/runs/456/attempts/2/jobs',
      data: { total_count: 1, jobs: [{ id: 789, run_attempt: 2 }] },
    },
  ]);
  const result = await invoke(
    ['workflow-job-list', '--repo', 'owner/repo', '--run-id', '456', '--attempt', '2'],
    mock,
  );

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.output.data[0].runAttempt, 2);
  mock.done();
});

test('job logs follow a signed download without forwarding auth and report limits', async () => {
  const previous = globalThis.fetch;
  const mock = httpMock([
    {
      path: '/repos/owner/repo/actions/jobs/456/logs',
      status: 302,
      headers: { location: 'https://logs.example.test/signed?secret=do-not-print' },
    },
  ]);

  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://logs.example.test/signed?secret=do-not-print');
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, 'error');

    return new Response('line one\nline two\nline three\n');
  };

  try {
    const result = await invoke(
      ['workflow-job-logs', '--repo', 'owner/repo', '--job-id', '456', '--max-lines', '2'],
      mock,
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.output.data.text, 'line one\nline two');
    assert.equal(result.output.data.truncated, true);
    assert.ok(!result.stdout.includes('do-not-print'));
    mock.done();
  } finally {
    globalThis.fetch = previous;
  }
});

test('job log reads stop downloading once the requested lines are available', async () => {
  let pulls = 0;
  const endless = new ReadableStream(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(Buffer.from(`line ${pulls}\n`));
      },
    },
    { highWaterMark: 0 },
  );

  assert.deepEqual(await readLogLines(endless, 1024 * 1024, 3), {
    text: 'line 1\nline 2\nline 3',
    truncated: true,
    returnedLines: 3,
  });
  assert.ok(pulls <= 5, `read ${pulls} chunks`);
});

test('job logs ending exactly at the line limit are complete', async () => {
  const empty = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });

  assert.deepEqual(await readLogLines(new Response('a\nb\n').body, 1024, 2), {
    text: 'a\nb\n',
    truncated: false,
    returnedLines: 2,
  });
  assert.deepEqual(await readLogLines(new Response('a\nb\nc').body, 1024, 3), {
    text: 'a\nb\nc',
    truncated: false,
    returnedLines: 3,
  });
  assert.deepEqual(await readLogLines(new Response('ab🙂cd\nnext').body, 4, 10), {
    text: 'ab',
    truncated: true,
    returnedLines: 1,
  });
  assert.deepEqual(await readLogLines(empty, 1024, 10), {
    text: '',
    truncated: false,
    returnedLines: 0,
  });
});

test('UTF-8 diff truncation does not invent replacement characters', async () => {
  const mock = httpMock([
    { response: new Response('abcdef🙂tail', { headers: { 'content-type': 'text/plain' } }) },
  ]);
  const result = await invoke(
    ['pr-diff', '--repo', 'owner/repo', '--number', '123', '--max-bytes', '8'],
    mock,
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.data.diff, 'abcdef');
  assert.equal(result.output.data.truncated, true);
  assert.equal(result.output.data.returnedBytes, 6);
  mock.done();
});
