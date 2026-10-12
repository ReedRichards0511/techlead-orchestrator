import { spawnSync } from 'node:child_process';

export function gitPorcelain(repo) {
  const r = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l && !/^\?\? \.orchestrator\//.test(l))
    .sort()
    .join('\n');
}
