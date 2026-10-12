import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { lockStatus, releaseLock } from '../safety.mjs';

export async function main(args) {
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const s = lockStatus(repo);
  if (!s.held) {
    console.log('No lock is held.');
    return 0;
  }
  console.log(`Lock held by plan ${s.planId} (run ${s.runId ?? 'none'}), pid ${s.pid ?? 'none'}, ${s.live ? 'worker RUNNING' : 'no live worker'}, since ${s.createdAt}`);
  if (!args.includes('--yes')) {
    console.error('Re-run with --yes to release it.');
    return 2;
  }
  if (s.live && !args.includes('--force')) {
    console.error('The worker of this lock is still running (live). Wait for it, or use --force to release anyway.');
    return 1;
  }
  releaseLock({ repo, planId: s.planId, force: true });
  console.log('Lock released.');
  return 0;
}
