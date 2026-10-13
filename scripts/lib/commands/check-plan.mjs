import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { validatePlan } from '../validate.mjs';
import { checkFileOperations } from '../file-operations.mjs';
import { loadConfig } from '../config.mjs';
import { devServersFor } from './preflight.mjs';

export async function main(args, ctx) {
  const file = option(args, '--plan');
  if (!file) { console.error('Usage: orch check-plan --plan <path> [--repo dir] [--json]'); return 2; }
  const planText = readFileSync(resolve(file), 'utf8');
  const result = validatePlan(planText);
  try { result.fileOperations = checkFileOperations({ repo: resolve(option(args, '--repo') ?? process.cwd()), planText }); }
  catch (e) { result.ok = false; result.errors.push(e.message); }
  // Detected before the worker question, because orch go launches without stopping.
  const devServers = await devServersFor({ args, config: loadConfig({ stateDir: ctx.stateDir }), repo: resolve(option(args, '--repo') ?? process.cwd()), planPath: resolve(file) });
  if (devServers?.warning) result.devServers = devServers;
  console.log(args.includes('--json') ? JSON.stringify(result) : [result.ok ? 'PLAN OK; review dependency types and project rules before choosing a worker.' : result.errors.join('\n'), ...(result.devServers ? [`WARNING: ${result.devServers.warning}`] : [])].join('\n'));
  return result.ok ? 0 : 1;
}
