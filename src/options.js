export const string = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const flag = (description) => ({ type: 'boolean', description });
export const integer = (description, extra = {}) =>
  string(description, { integer: true, min: 1, ...extra });

export const globalOptions = {
  repo: string('GitHub repository owner/repo; otherwise infer from Git remotes.'),
  timeout: integer('Request timeout in milliseconds.', { default: '30000', max: 300000 }),
  pretty: flag('Indent the JSON result.'),
  help: flag('Show command help without authentication.'),
  version: flag('Show the CLI version without authentication.'),
};

export const restPaging = {
  page: integer('Start at this REST page.', { default: '1' }),
  'per-page': integer('API page size.', { default: '50', max: 100 }),
  all: flag('Fetch all remaining pages sequentially.'),
};
export const graphPaging = {
  after: string('GraphQL cursor from the previous result.'),
  'per-page': integer('GraphQL page size.', { default: '50', max: 100 }),
  all: flag('Fetch all remaining connection pages sequentially.'),
};
export const conditional = {
  'if-none-match': string('ETag for a single REST request; incompatible with --all.'),
};
export const number = { number: integer('Issue or pull request number.') };
export const commentId = { 'comment-id': integer('Numeric comment ID.') };
export const body = {
  body: string('Markdown body. Mutually exclusive with --body-file.'),
  'body-file': string('UTF-8 Markdown file, or - to read standard input.'),
};
export const since = {
  since: string('ISO 8601 timestamp; see the command limitations.', { timestamp: true }),
};
export const ref = { ref: string('Branch, tag or commit SHA.') };
export const sorting = {
  sort: string('Sort field.', { choices: ['created', 'updated', 'comments'], default: 'created' }),
  direction: string('Sort direction.', { choices: ['asc', 'desc'], default: 'desc' }),
};

export function command(name, group, description, options, required, example, result, notes, run) {
  return { name, group, description, options, required, example, result, notes, run };
}
