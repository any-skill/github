# Any Skill GitHub CLI

A standalone, non-interactive GitHub client for AI agents, shell scripts and
applications. Run it directly from GitHub with npx. No GitHub CLI (`gh`), MCP
server, agent runtime or global installation is required. This package is not
published to npm.

It supports repositories/branches/commits, Issues and comments, Pull Requests,
reviews and inline feedback, GraphQL review threads, commit statuses, Checks,
GitHub Actions runs/jobs/logs and external polling through IDs and timestamps.
Use standard Git for clone, checkout, source edits, commit and push.

## Requirements and authentication

- Node.js 24+, npm/npx and Git for GitHub package resolution.
- Network access to GitHub and npm for installation; GitHub.com API for operation.
- `GITHUB_TOKEN` in the process environment, with access to the selected repository
  and the endpoint permissions required by the operation. The CLI never logs in
  interactively or loads `.env` automatically.

Use a classic PAT, fine-grained PAT or already-issued GitHub App token. Private
repository access with a classic PAT generally requires `repo`. Fine-grained
access depends on the operation: Contents/Metadata, Issues, Pull requests, Checks
and Actions. Read permission is sufficient for reading; mutations need write
permission. Tokens do not bypass review authorship or repository restrictions.

## Quick start

Set the environment variable using your credential mechanism, then:

```bash
npx -y github:any-skill/github --help
npx -y github:any-skill/github issue-list --repo owner/repo
npx -y github:any-skill/github issue-get --repo owner/repo --number 123
npx -y github:any-skill/github pr-list --repo owner/repo --head owner:feature --all
npx -y github:any-skill/github pr-checks --repo owner/repo --number 123
npx -y github:any-skill/github review-thread-list --repo owner/repo --number 123 --all
```

For reproducible execution, quote the package reference and use a tag or full SHA:

```bash
npx -y 'github:any-skill/github#v1.0.0' pr-list --repo owner/repo
npx -y 'github:any-skill/github#<full-commit-sha>' repo-get --repo owner/repo
```

Replace placeholders with actual values. This package includes npm-shrinkwrap.json
to fix its dependency resolution. Default-ref execution is subject to npm caching.
The package is public; the target repository may be private. API authentication is
separate from Git authentication needed to download a private package or push.

## Typical operations

```bash
npx -y github:any-skill/github issue-search --repo owner/repo --query 'is:open label:bug'
npx -y github:any-skill/github issue-comment-list --repo owner/repo --number 123 --all
npx -y github:any-skill/github pr-get --repo owner/repo --number 123
npx -y github:any-skill/github pr-files --repo owner/repo --number 123 --all
npx -y github:any-skill/github review-list --repo owner/repo --number 123 --all
npx -y github:any-skill/github workflow-job-logs --repo owner/repo --job-id 456 --max-lines 200
```

When explicitly assigned to write:

```bash
npx -y github:any-skill/github issue-create --repo owner/repo --title 'Fix startup' --body-file issue.md
npx -y github:any-skill/github pr-create --repo owner/repo --head feature --base main --title 'Fix startup' --body-file pr.md --draft
npx -y github:any-skill/github review-submit --repo owner/repo --number 123 --event request-changes --body 'Handle the empty input'
```

The complete command reference, result shapes, permissions, error handling,
pagination rules and agent workflows are in [SKILL.md](SKILL.md). Copy that single
file into an agent's `github/` skill folder; no supporting files are required.

## JSON and automation

API successes return `{schemaVersion:1,data,meta}` on stdout. Errors return JSON
on stderr with a nonzero exit code. Help/version are text. REST keys are camelCase;
upstream resource fields are additive. Numeric IDs exceeding JavaScript's safe
integer range are strings. A failed CI check is successfully read data, not a CLI
execution error. Rate limits include retry metadata when available; writes are
never retried automatically. The supplied token is redacted from output.

Lists default to one page of 50. Follow continuation or pass `--all`. Thread lists
preview ten comments per thread; use `review-thread-get --all` for a complete
thread. API limits and incomplete searches are reported. Read the pagination
metadata rather than interpreting an empty filtered page as the end.

Polling callers own state and scheduling. Timestamp filters do not provide a
complete event journal, especially for review dismissals/resolution changes.
Compare complete snapshots for those states. This CLI has no persistent state,
scheduler, webhooks, workflow engine or platform-specific integration.

## Development and validation

```bash
git clone https://github.com/any-skill/github.git
cd github
npm ci
npm test
node bin/github.js --help
```

There is no build step: sources are JavaScript ESM `.js` files (`"type": "module"`).
`npm test` runs Node's built-in tests with mocked GitHub HTTP responses; it performs
no live GitHub writes. Keep SKILL.md aligned with the actual command definitions
when changing commands or options.

The only direct runtime dependencies are `@octokit/core` 7.0.8 and
`@octokit/plugin-paginate-rest` 14.0.0. Node built-ins handle
arguments, files, subprocesses, streams and tests.

The command catalogue in `src/commands/` shares only argument/result helpers.
`src/client.js` owns Octokit requests, pagination and response normalization;
`src/cli.js` owns streams/exit codes. Extend the relevant domain module, add
meaningful HTTP-level tests and update its command metadata. No plugins or runtime
framework are involved. `private: true` prevents accidental npm publication while
the single bin entry still supports GitHub npx installation.

Before release, run read-only API validation against the assigned test repository
with a suitable token. Verify actual npx installation from default ref, tag and
commit in a clean npm cache.
