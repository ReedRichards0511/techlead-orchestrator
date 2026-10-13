import { spawnSync } from 'node:child_process';

export function gitPaths(repo) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel', '--show-prefix'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.status !== 0) return null;
  const [root, prefix = ''] = r.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
  return { root, prefix };
}

export function gitPorcelain(repo) {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true });
  if (r.status !== 0) return null;
  const statePrefix = `${gitPaths(repo)?.prefix ?? ''}.orchestrator/`;
  return r.stdout
    .split('\0')
    .filter((l) => l && !l.slice(3).startsWith(statePrefix))
    .sort()
    .join('\n');
}
