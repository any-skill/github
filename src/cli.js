import pkg from '../package.json' with { type: 'json' };
import { commands } from './commands.js';
import { parseArguments } from './arguments.js';
import { resolveRepository } from './repository.js';
import { createContext } from './client.js';
import { CliError, apiError, redact } from './errors.js';
import { help } from './help.js';

export async function main(argv, runtime = {}) {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const environment = runtime.env ?? process.env;
  const token = environment.GITHUB_TOKEN?.trim();

  try {
    if (Number(process.versions.node.split('.')[0]) < 24) {
      throw new CliError('UNSUPPORTED_NODE', 'Node.js 24 or newer is required.', 2);
    }

    const { command, options } = parseArguments(argv, commands);

    if (options.version) {
      stdout.write(`${pkg.version}\n`);

      return 0;
    }
    if (options.help) {
      stdout.write(help(commands, command));

      return 0;
    }
    if (!token) {
      throw new CliError('TOKEN_REQUIRED', 'Set GITHUB_TOKEN in the process environment.', 3);
    }

    const repository = await resolveRepository(options.repo, runtime.cwd);
    const context = createContext(repository, options, token, runtime.octokit);
    const result = await command.run(context, options);
    const output = {
      schemaVersion: 1,
      data: result.data,
      meta: {
        command: command.name,
        repository: repository.fullName,
        observedAt: new Date().toISOString(),
        ...result.meta,
      },
    };

    const serialized = JSON.stringify(output, null, options.pretty ? 2 : undefined);

    stdout.write(`${redact(serialized, token)}\n`);

    return 0;
  } catch (error) {
    const failure = apiError(error, token);

    const serialized = JSON.stringify({
      schemaVersion: 1,
      error: {
        code: failure.code,
        message: failure.message,
        ...failure.details,
      },
    });

    stderr.write(`${redact(serialized, token)}\n`);

    return failure.exitCode;
  }
}
