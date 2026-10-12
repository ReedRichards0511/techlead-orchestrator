import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { preflight } from '../safety.mjs';

export function formatPreflight(r) {
  if (r.needsConfirmation) {
    return [
      'PREFLIGHT: the working tree has changes that are not part of this task:',
      ...r.dirtyFiles.map((f) => `  - ${f}`),
      'Ask Reed, then re-run with --accept-dirty to continue.',
    ].join('\n');
  }
  if (!r.ok) return `PREFLIGHT FAILED: ${r.error}`;
  const failing = r.snapshot.baseline.filter((b) => !b.passed);
  return [
    `PREFLIGHT OK for plan ${r.planId}`,
    `  HEAD ${r.snapshot.head?.slice(0, 10)} on ${r.snapshot.branch}`,
    `  lock held, snapshot at ${r.snapshotPath}`,
    `  baseline: ${r.snapshot.baseline.length} command(s), ${failing.length} failing before the change`,
    ...failing.map((b) => `    - failing: ${b.command}`),
  ].join('\n');
}

export async function main(args, ctx) {
  const planArg = option(args, '--plan');
  if (!planArg) {
    console.error('Usage: orch preflight --plan <path> [--repo dir] [--accept-dirty] [--skip-baseline] [--json]');
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const planPath = resolve(planArg);
  if (!existsSync(planPath)) {
    console.error(`Plan not found: ${planPath}`);
    return 1;
  }
  const config = loadConfig({ stateDir: ctx.stateDir });
  const r = await preflight({
    repo,
    planPath,
    config,
    acceptDirty: args.includes('--accept-dirty'),
    skipBaseline: args.includes('--skip-baseline'),
  });
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatPreflight(r));
  return r.ok ? 0 : 1;
}
