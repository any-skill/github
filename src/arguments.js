import { parseArgs } from 'node:util';
import { globalOptions } from './options.js';
import { usage } from './errors.js';

function parse(argv, definitions) {
  try {
    return parseArgs({
      args: argv,
      options: Object.fromEntries(
        Object.entries(definitions).map(([key, value]) => [
          key,
          { type: value.type, multiple: Boolean(value.multiple) },
        ]),
      ),
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (error) {
    throw usage(error.message);
  }
}

export function parseArguments(argv, commands) {
  // First identify the command using the union of known options. Validation below
  // rejects options that belong to another command.
  const union = Object.assign({}, globalOptions, ...commands.map((entry) => entry.options));
  const parsed = parse(argv, union);

  if (parsed.positionals.length > 1) {
    throw usage('Expected one command; use named options for all parameters.');
  }

  const name = parsed.positionals[0];
  const selected = commands.find((entry) => entry.name === name);

  if (name && !selected) {
    throw usage(`Unknown command: ${name}. Use --help.`);
  }
  if (!selected && !parsed.values.help && !parsed.values.version) {
    throw usage('A command is required. Use --help.');
  }

  const definitions = { ...globalOptions, ...(selected?.options ?? {}) };
  const { values, tokens } = parse(argv, definitions);
  const seen = new Set();

  for (const token of tokens) {
    if (token.kind !== 'option') {
      continue;
    }
    if (seen.has(token.name) && !definitions[token.name].multiple) {
      throw usage(`--${token.name} may only be supplied once.`);
    }
    seen.add(token.name);
  }

  for (const [key, value] of Object.entries(values)) {
    if (!definitions[key]) {
      throw usage(`--${key} is not supported by ${name ?? 'global help'}.`);
    }
    if (typeof value === 'string' && !value.trim() && !['body', 'title'].includes(key)) {
      throw usage(`--${key} must not be empty.`);
    }
  }
  if (values.help || values.version) {
    return { command: selected, options: values };
  }
  for (const [key, definition] of Object.entries(definitions)) {
    if (values[key] === undefined && definition.default !== undefined) {
      values[key] = definition.default;
    }
    if (values[key] === undefined) {
      continue;
    }
    if (definition.integer) {
      if (
        !/^\d+$/.test(values[key]) ||
        !Number.isSafeInteger(Number(values[key])) ||
        Number(values[key]) < definition.min ||
        (definition.max !== undefined && Number(values[key]) > definition.max)
      ) {
        throw usage(
          `--${key} must be an integer from ${definition.min}${definition.max ? ` to ${definition.max}` : ''}.`,
        );
      }
      values[key] = Number(values[key]);
    }
    if (definition.choices && !definition.choices.includes(values[key])) {
      throw usage(`--${key} must be one of: ${definition.choices.join(', ')}.`);
    }
    if (
      definition.timestamp &&
      (!/^\d{4}-\d{2}-\d{2}T/.test(values[key]) ||
        !/(Z|[+-]\d{2}:\d{2})$/i.test(values[key]) ||
        !Number.isFinite(Date.parse(values[key])))
    ) {
      throw usage(`--${key} must be an ISO 8601 timestamp including a time and timezone.`);
    }
  }
  for (const key of selected.required) {
    if (values[key] === undefined || (typeof values[key] === 'string' && !values[key].trim())) {
      throw usage(`--${key} is required for ${name}.`);
    }
  }
  if (values.body !== undefined && values['body-file'] !== undefined) {
    throw usage('Use only one of --body and --body-file.');
  }
  if (values.all && values['if-none-match']) {
    throw usage('--if-none-match applies to one page and cannot be used with --all.');
  }

  return { command: selected, options: values };
}
