import { join, resolve } from 'node:path';
import { option } from '../decide.mjs';
import { restoreDevinAllowlist } from '../devin-allow.mjs';
import { listRunDirs, lockStatus, releaseLock } from '../safety.mjs';

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
  releaseRepoLock(repo, s);
  return 0;
}

export function releaseRepoLock(repo, s) {
  releaseLock({ repo, planId: s.planId, force: true });
  for (const id of listRunDirs(repo)) {
    if (restoreDevinAllowlist({ repo, runDir: join(repo, '.orchestrator', 'runs', id) })) console.log(`Restored .devin/config.local.json left by run ${id}.`);
  }
  console.log('Lock released.');
}
