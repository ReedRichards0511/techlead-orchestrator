import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { lockStatus } from '../safety.mjs';
import { formatUsage, reportUsage } from '../usage.mjs';
import { main as history } from './history.mjs';
import { releaseRepoLock } from './unlock.mjs';

// Closing turn in one call: release the task lock, record the original run and print the token report last.
export async function main(args, ctx) {
  const task = option(args, '--task');
  if (!task) {
    console.error('Usage: orch close [runId] --task <id> --session <id> [--verdict PASS|REPAIR_REQUIRED] [--repairs N] [--repo dir]');
    return 2;
  }
  const runId = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const lock = lockStatus(repo);
  if (lock.held && lock.planId === task) {
    if (lock.live) {
      console.error(`The worker of run ${lock.runId} is still running; wait for it before closing.`);
      return 1;
    }
    releaseRepoLock(repo, lock);
  }
  if (runId) {
    const pass = (flag) => (option(args, flag) === undefined ? [] : [flag, option(args, flag)]);
    const code = await history(['record', runId, ...pass('--verdict'), ...pass('--repairs'), '--repo', repo], ctx);
    if (code) return code;
  }
  console.log(formatUsage(reportUsage({ repo, task, session: option(args, '--session') })));
  return 0;
}
