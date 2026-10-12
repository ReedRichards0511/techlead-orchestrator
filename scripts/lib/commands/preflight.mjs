import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { DEFAULT_DEV_PORTS, detectDevServers, devServerAdvice } from '../devserver.mjs';
import { preflight } from '../safety.mjs';
import { parsePlanValidation } from '../validate.mjs';

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
  const dev = r.devServers;
  return [
    `PREFLIGHT OK for plan ${r.planId}`,
    `  HEAD ${r.snapshot.head?.slice(0, 10)} on ${r.snapshot.branch}`,
    `  lock held, snapshot at ${r.snapshotPath}`,
    `  baseline: ${r.snapshot.baseline.length} command(s), ${failing.length} failing before the change`,
    ...failing.map((b) => `    - failing: ${b.command}`),
    ...(dev
      ? [
          `  dev server detected on ${dev.ports.map((p) => `:${p}`).join(', ')}`,
          ...(dev.warning ? [`  WARNING: ${dev.warning}`, ...dev.restoreSteps.map((s) => `    - after the run: ${s}`)] : []),
        ]
      : []),
  ].join('\n');
}

function devPorts(args, config) {
  const given = option(args, '--dev-ports');
  if (given) return given.split(',').map(Number).filter(Number.isInteger);
  return config.safety?.devServerPorts ?? DEFAULT_DEV_PORTS;
}

function readPackageJson(repo) {
  try {
    return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export async function main(args, ctx) {
  const planArg = option(args, '--plan');
  if (!planArg) {
    console.error('Usage: orch preflight --plan <path> [--repo dir] [--accept-dirty] [--skip-baseline] [--dev-ports a,b] [--json]');
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
  if (r.ok) {
    r.devServers = devServerAdvice({
      openPorts: await detectDevServers({ ports: devPorts(args, config) }),
      commands: parsePlanValidation(readFileSync(planPath, 'utf8')),
      packageJson: readPackageJson(repo),
    });
  }
  console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatPreflight(r));
  return r.ok ? 0 : 1;
}
