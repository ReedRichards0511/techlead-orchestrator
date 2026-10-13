import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog, option } from '../decide.mjs';
import { loadConfig } from '../config.mjs';
import { CLASSES } from '../router.mjs';
import { allowlistRetryOf, startRun } from '../run.mjs';

const HARNESS_OF_PREFIX = { devin: 'devin', codex: 'codex', agy: 'agy' };

// Returns the started run, or { code } after printing why nothing was launched.
export async function launch(args, ctx) {
  const planArg = option(args, '--plan');
  const klass = option(args, '--class');
  if (!planArg || !klass || !CLASSES[klass]) {
    console.error(`Usage: orch run --plan <path> --class <${Object.keys(CLASSES).join('|')}> --model id --effort e [--harness h] [--permission mode] [--packet file | --repair points.json | --continuation state.json] [--project-rules file] [--allow-from runId] [--repo dir]`);
    if (klass && !CLASSES[klass]) console.error(`Unknown class: ${klass}`);
    return { code: 2 };
  }

  const modelId = option(args, '--model');
  const effort = option(args, '--effort');
  if (!modelId || modelId.startsWith('--') || !effort || effort.startsWith('--')) {
    console.error('User selection required: pass an explicit --model and --effort after the user chooses a worker. Run orch route to see recommendations.');
    return { code: 2 };
  }

  const repairArg = option(args, '--repair');
  const continuationArg = option(args, '--continuation');
  if (repairArg && continuationArg) {
    console.error('Use either --repair or --continuation, not both');
    return { code: 2 };
  }

  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const planPath = resolve(planArg);
  if (!existsSync(planPath)) {
    console.error(`Plan not found: ${planPath}`);
    return { code: 1 };
  }

  let packetKind;
  let packetData;
  if (repairArg || continuationArg) {
    packetKind = repairArg ? 'repair' : 'continuation';
    const file = resolve(repairArg ?? continuationArg);
    try {
      packetData = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`Cannot read ${packetKind} file ${file}: ${e.message}`);
      return { code: 1 };
    }
    if (packetKind === 'repair' && !(Array.isArray(packetData.points) && packetData.points.length)) {
      console.error('The repair file needs a non-empty "points" list: [{file, line?, issue, expected?}]');
      return { code: 1 };
    }
  }

  try {
    const catalog = loadCatalog(ctx.stateDir);
    const config = loadConfig({ stateDir: ctx.stateDir });
    const entry = catalog.models.find((m) => m.id === modelId);
    if (!entry) throw new Error(`Unknown model: ${modelId}`);
    const harness = option(args, '--harness');
    if (harness && (harness !== entry.harness || HARNESS_OF_PREFIX[harness] === undefined)) {
      throw new Error(`Harness ${harness} does not match model ${modelId} (${entry.harness})`);
    }
    if (!entry.enabled) throw new Error(`Model ${modelId} is disabled`);
    if (!entry.allowedEfforts.includes(effort)) throw new Error(`effort ${effort} is not allowed for ${modelId} (allowed: ${entry.allowedEfforts.join(', ')})`);

    const allowFrom = option(args, '--allow-from');
    const retry = allowFrom ? allowlistRetryOf({ repo, runId: allowFrom }) : null;
    const packetFile = option(args, '--packet');
    const rulesFile = option(args, '--project-rules');
    const run = startRun({
      repo,
      planPath,
      klass,
      entry,
      effort,
      config,
      permission: option(args, '--permission'),
      packetText: packetFile ? readFileSync(resolve(packetFile), 'utf8') : undefined,
      packetKind,
      packetData,
      projectRules: rulesFile ? readFileSync(resolve(rulesFile), 'utf8') : undefined,
      allowExec: retry?.allowExec,
      retryOf: retry?.retryOf,
      project: option(args, '--project'),
      title: option(args, '--title'),
    });
    return { ...run, harness: entry.harness, model: entry.id, effort };
  } catch (e) {
    console.error(e.message);
    return { code: 1 };
  }
}

export async function main(args, ctx) {
  const run = await launch(args, ctx);
  if (run.code) return run.code;
  console.log(JSON.stringify(run, null, 2));
  return 0;
}
