import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { Octokit } from '../src/client.js';

export const TOKEN = 'test-secret-token-for-mocks';

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function httpMock(steps) {
  let index = 0;
  const requests = [];
  const octokit = new Octokit({
    auth: TOKEN,
    request: {
      fetch: async (url, init) => {
        const step = steps[index++];

        assert.ok(step, `Unexpected HTTP request ${init.method} ${url}`);

        const parsed = new URL(url);
        const body = init.body ? JSON.parse(init.body) : undefined;

        requests.push({ url: parsed, method: init.method, body, headers: init.headers });
        if (step.method) {
          assert.equal(init.method, step.method);
        }
        if (step.path) {
          assert.equal(decodeURIComponent(parsed.pathname), step.path);
        }
        for (const [key, value] of Object.entries(step.query ?? {})) {
          assert.equal(parsed.searchParams.get(key), String(value));
        }
        if (step.body) {
          assert.deepEqual(body, step.body);
        }
        if (step.inspect) {
          step.inspect({ parsed, init, body });
        }

        const response =
          step.response ?? jsonResponse(step.data ?? {}, step.status ?? 200, step.headers);

        Object.defineProperty(response, 'url', { value: parsed.href });

        return response;
      },
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  });

  return {
    octokit,
    requests,
    done() {
      assert.equal(index, steps.length, 'Not all expected requests occurred');
    },
  };
}

export async function invoke(args, mock, extra = {}) {
  let stdout = '';
  let stderr = '';
  const exitCode = await main(args, {
    env: { GITHUB_TOKEN: TOKEN },
    stdout: {
      write(value) {
        stdout += value;
      },
    },
    stderr: {
      write(value) {
        stderr += value;
      },
    },
    octokit: mock?.octokit,
    ...extra,
  });

  return {
    exitCode,
    stdout,
    stderr,
    output: stdout.startsWith('{') ? JSON.parse(stdout) : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}
