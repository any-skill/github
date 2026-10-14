import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { usage } from './errors.js';

const MAX_BODY_BYTES = 1024 * 1024;

// Files and standard input share one bounded reader so an oversized file is rejected
// without being loaded into memory first.
async function readBounded(stream) {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw usage('Body input exceeds 1 MiB.');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks, size).toString('utf8');
}

export async function readBody(options, required = false, stdin = process.stdin) {
  let value = options.body;
  const source = options['body-file'];

  if (source) {
    if (source === '-' && stdin.isTTY) {
      throw usage('--body-file - requires piped standard input.');
    }
    try {
      value = await readBounded(source === '-' ? stdin : createReadStream(source));
    } catch (error) {
      if (error.exitCode) {
        throw error;
      }

      throw usage('Cannot read --body-file.');
    }
  }
  if (value !== undefined && value.length > 65536) {
    throw usage('Markdown body exceeds 65536 characters.');
  }
  if (required && !value?.trim()) {
    throw usage('A non-empty --body or --body-file is required.');
  }

  return value;
}

export async function readReviewComments(path) {
  if (!path) {
    return undefined;
  }

  let value;

  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw usage('--comments-file must be a readable UTF-8 JSON file.');
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw usage('--comments-file must contain an array of 1 to 100 inline comments.');
  }
  for (const comment of value) {
    if (
      !comment ||
      typeof comment !== 'object' ||
      Array.isArray(comment) ||
      typeof comment.path !== 'string' ||
      !comment.path.trim() ||
      typeof comment.body !== 'string' ||
      !comment.body.trim() ||
      !Number.isSafeInteger(comment.line) ||
      comment.line < 1 ||
      !['LEFT', 'RIGHT'].includes(comment.side) ||
      Object.keys(comment).some(
        (key) => !['path', 'body', 'line', 'side', 'start_line', 'start_side'].includes(key),
      )
    ) {
      throw usage(
        'Each inline comment needs path, body, positive line and side LEFT|RIGHT. Only start_line/start_side are additionally allowed.',
      );
    }
    if (
      comment.start_line !== undefined &&
      (!Number.isSafeInteger(comment.start_line) ||
        comment.start_line < 1 ||
        comment.start_line > comment.line ||
        !['LEFT', 'RIGHT'].includes(comment.start_side))
    ) {
      throw usage('Multi-line comments need start_line <= line and start_side LEFT|RIGHT.');
    }
    if (comment.start_side !== undefined && comment.start_line === undefined) {
      throw usage('start_side requires start_line.');
    }
  }

  return value;
}

export function requireChanges(parameters) {
  if (!Object.values(parameters).some((value) => value !== undefined)) {
    throw usage('Supply at least one field to update.');
  }
}
