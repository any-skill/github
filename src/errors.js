export class CliError extends Error {
  constructor(code, message, exitCode = 8, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function usage(message) {
  return new CliError('INVALID_ARGUMENT', message, 2);
}

export function redact(text, token) {
  return token ? text.replaceAll(token, '[REDACTED]') : text;
}

export function apiError(error, token = '') {
  if (error instanceof CliError) {
    return error;
  }

  const headers = error.response?.headers ?? {};
  const status = error.status ?? error.response?.status;
  const graphErrors = error.errors ?? error.response?.errors ?? [];
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers['x-ratelimit-remaining'] === '0' ||
        headers['retry-after'] ||
        /rate limit|secondary rate/i.test(error.message ?? ''))) ||
    graphErrors.some((entry) => entry.type === 'RATE_LIMITED');
  const message = redact(String(error.message ?? 'Unexpected failure'), token);
  const details = {};

  if (status) {
    details.status = status;
  }
  if (headers['x-github-request-id']) {
    details.requestId = headers['x-github-request-id'];
  }
  if (rateLimited) {
    if (headers['retry-after']) {
      details.retryAfterSeconds = Number(headers['retry-after']);
    }
    if (headers['x-ratelimit-reset']) {
      details.resetAt = new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString();
    }

    return new CliError('RATE_LIMITED', message, 6, details);
  }
  if (status === 401) {
    return new CliError(
      'AUTHENTICATION_FAILED',
      'GITHUB_TOKEN was rejected by GitHub.',
      3,
      details,
    );
  }
  if (status === 403 || graphErrors.some((entry) => entry.type === 'FORBIDDEN')) {
    return new CliError('PERMISSION_DENIED', message, 4, details);
  }
  if (status === 404 || graphErrors.some((entry) => entry.type === 'NOT_FOUND')) {
    return new CliError(
      'NOT_FOUND',
      'Resource not found or not visible to this token.',
      5,
      details,
    );
  }
  if (
    (!status || (!error.response && status === 500)) &&
    (error.cause ||
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      /fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT/i.test(message))
  ) {
    return new CliError('NETWORK_ERROR', 'GitHub request failed or timed out.', 7);
  }

  return new CliError(
    status || graphErrors.length ? 'API_ERROR' : 'INTERNAL_ERROR',
    message,
    status || graphErrors.length ? 8 : 1,
    details,
  );
}

export function expectObject(data, label = 'GitHub response') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CliError('INVALID_RESPONSE', `${label} must be an object.`);
  }

  return data;
}
