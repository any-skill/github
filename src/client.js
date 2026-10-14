import { Octokit as OctokitCore } from '@octokit/core';
import { paginateRest } from '@octokit/plugin-paginate-rest';
import pkg from '../package.json' with { type: 'json' };
import { CliError, expectObject } from './errors.js';

export const API_VERSION = '2026-03-10';

// Only request, graphql and paginate are used; @octokit/rest's generated endpoint methods
// would add startup time to every one-shot CLI process without being called.
export const Octokit = OctokitCore.plugin(paginateRest);

const NEXT_LINK = /<([^>]+)>;\s*rel="next"/;

// Await independent requests concurrently, but surface the first failure in argument order
// so the reported error does not depend on which response arrives first.
export async function concurrently(...promises) {
  const results = await Promise.allSettled(promises);
  const failure = results.find((result) => result.status === 'rejected');

  if (failure) {
    throw failure.reason;
  }

  return results.map((result) => result.value);
}

export function normalize(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()),
        normalize(child),
      ]),
    );
  }

  return value;
}

export function responseMetadata(headers = {}) {
  const meta = {};

  if (headers.etag) {
    meta.etag = headers.etag;
  }
  if (headers.link) {
    const next = headers.link.match(NEXT_LINK)?.[1];

    meta.pagination = {
      hasNextPage: Boolean(next),
      nextPage: next ? Number(new URL(next).searchParams.get('page')) : null,
    };
  }
  if (headers['x-ratelimit-remaining'] !== undefined) {
    const limit = Number(headers['x-ratelimit-limit']);
    const remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']);

    if ([limit, remaining, reset].every(Number.isFinite)) {
      meta.rateLimit = {
        limit,
        remaining,
        resetAt: new Date(reset * 1000).toISOString(),
        resource: headers['x-ratelimit-resource'] ?? null,
      };
    }
  }

  return meta;
}

export function createContext(repository, options, token, injectedOctokit) {
  const octokit =
    injectedOctokit ??
    new Octokit({
      auth: token,
      userAgent: `any-skill-github/${pkg.version}`,
      request: {
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            signal: init.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(options.timeout)])
              : AbortSignal.timeout(options.timeout),
          }),
      },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    });
  const base = { owner: repository.owner, repo: repository.repo };
  const conditional = options['if-none-match'] ? { 'if-none-match': options['if-none-match'] } : {};

  function notModified(error) {
    return {
      data: null,
      meta: { ...responseMetadata(error.response?.headers), notModified: true },
    };
  }

  async function request(route, parameters = {}) {
    return octokit.request(route, {
      ...base,
      ...parameters,
      headers: { 'x-github-api-version': API_VERSION, ...parameters.headers },
    });
  }

  async function single(route, parameters = {}) {
    let response;

    try {
      response = await request(route, {
        ...parameters,
        headers: { ...parameters.headers, ...conditional },
      });
    } catch (error) {
      if (error.status === 304) {
        return notModified(error);
      }

      throw error;
    }

    return {
      data: normalize(expectObject(response.data)),
      meta: responseMetadata(response.headers),
    };
  }

  async function list(route, parameters = {}, filter = () => true) {
    const items = [];
    let page = options.page ?? 1;
    let lastResponse;
    let hasNextPage = false;
    let totalCount = null;
    let incomplete = false;
    const iterator = octokit.paginate.iterator(route, {
      ...base,
      ...parameters,
      page,
      per_page: options['per-page'],
      headers: { 'x-github-api-version': API_VERSION, ...parameters.headers, ...conditional },
    });

    try {
      for await (const response of iterator) {
        if (!Array.isArray(response.data)) {
          throw new CliError('INVALID_RESPONSE', 'Expected a paginated GitHub array.');
        }
        lastResponse = response;
        items.push(
          ...response.data.map((entry) => expectObject(entry, 'GitHub list entry')).filter(filter),
        );
        totalCount = response.data.total_count ?? totalCount;
        incomplete ||= response.data.incomplete_results === true;
        hasNextPage = NEXT_LINK.test(response.headers.link ?? '');

        if (!options.all || !hasNextPage) {
          break;
        }
        page++;
      }
    } catch (error) {
      if (error.status === 304) {
        return notModified(error);
      }

      // Discard partial lists on API failure so callers cannot mistake them for complete results.
      throw error;
    }

    return {
      data: normalize(items),
      meta: {
        ...responseMetadata(lastResponse?.headers),
        pagination: {
          page,
          perPage: options['per-page'],
          hasNextPage,
          nextPage: hasNextPage ? page + 1 : null,
          totalCount,
          returnedCount: items.length,
          complete: !hasNextPage && !incomplete,
          incompleteResults: incomplete,
        },
      },
    };
  }

  async function graph(query, variables = {}) {
    return octokit.graphql(query, { owner: base.owner, repo: base.repo, ...variables });
  }

  async function connection(query, variables, select, filter = () => true) {
    const nodes = [];
    let after = options.after;
    let pageInfo;
    let totalCount;
    const seen = new Set();

    do {
      const data = await graph(query, { ...variables, first: options['per-page'], after });
      const current = select(data);

      if (!current) {
        throw new CliError(
          'NOT_FOUND',
          'Repository, pull request or thread not found or not visible.',
          5,
        );
      }
      if (!Array.isArray(current.nodes) || typeof current.pageInfo?.hasNextPage !== 'boolean') {
        throw new CliError('INVALID_RESPONSE', 'Invalid GraphQL connection.');
      }
      nodes.push(...current.nodes.filter((node) => node !== null && filter(node)));
      pageInfo = current.pageInfo;
      totalCount = current.totalCount;
      after = pageInfo.endCursor;

      if (pageInfo.hasNextPage && (!after || seen.has(after))) {
        throw new CliError('INVALID_RESPONSE', 'GraphQL pagination did not advance.');
      }
      seen.add(after);
    } while (options.all && pageInfo.hasNextPage);

    return {
      data: nodes,
      meta: {
        pagination: {
          perPage: options['per-page'],
          hasNextPage: pageInfo.hasNextPage,
          nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
          totalCount: totalCount ?? null,
          returnedCount: nodes.length,
          complete: !pageInfo.hasNextPage,
        },
      },
    };
  }

  return {
    repository,
    options,
    octokit,
    base,
    request,
    single,
    list,
    graph,
    connection,
    withOptions: (overrides) =>
      createContext(repository, { ...options, ...overrides }, token, octokit),
  };
}
