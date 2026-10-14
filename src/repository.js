import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { usage } from './errors.js';

const execute = promisify(execFile);

export function parseRepository(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || /\/(\.|\.\.)$/.test(value)) {
    throw usage('--repo must be owner/repo on GitHub.com.');
  }

  const [owner, repo] = value.split('/');

  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function repositoryFromRemote(remote) {
  const match = remote.match(
    /^(?:git@github\.com:|https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i,
  );

  if (!match) {
    return null;
  }

  try {
    return parseRepository(match[1].replace(/\.git$/, ''));
  } catch {
    // A remote can be valid Git syntax without identifying a supported repository.
    return null;
  }
}

export async function resolveRepository(explicit, cwd = process.cwd(), git = execute) {
  if (explicit) {
    return parseRepository(explicit);
  }

  let remotes;

  try {
    ({ stdout: remotes } = await git('git', ['remote', '-v'], {
      cwd,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    throw usage('Cannot infer a GitHub repository here. Supply --repo owner/repo.');
  }

  const candidates = [];

  for (const line of remotes.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    const repository = match && repositoryFromRemote(match[2]);

    if (repository) {
      candidates.push({ name: match[1], repository });
    }
  }

  const origin = candidates.find((entry) => entry.name === 'origin');

  if (origin) {
    return origin.repository;
  }

  const unique = new Map(
    candidates.map((entry) => [entry.repository.fullName.toLowerCase(), entry.repository]),
  );

  if (unique.size === 1) {
    return [...unique.values()][0];
  }

  throw usage('No unambiguous GitHub remote. Supply --repo owner/repo.');
}
