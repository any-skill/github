import { repositoryCommands } from './commands/repository.js';
import { issueCommands } from './commands/issues.js';
import { commentCommands } from './commands/comments.js';
import { pullCommands } from './commands/pulls.js';
import { reviewCommands } from './commands/reviews.js';
import { threadCommands } from './commands/threads.js';
import { checkCommands } from './commands/checks.js';

export const commands = [
  ...repositoryCommands,
  ...issueCommands,
  ...commentCommands,
  ...pullCommands,
  ...reviewCommands,
  ...threadCommands,
  ...checkCommands,
];
