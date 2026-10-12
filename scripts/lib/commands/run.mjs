import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeDecision, loadCatalog, option } from '../decide.mjs';
import { loadConfig } from '../config.mjs';
import { CLASSES, formatDecision } from '../router.mjs';
import { startRun } from '../run.mjs';

const HARNESS_OF_PREFIX = { devin: 'devin', codex: 'codex', agy: 'agy' };

export async function main(args, ctx) {
  const planArg = option(args, '--plan');
  const klass = option(args, '--class');
  if (!planArg || !klass || !CLASSES[klass]) {
    console.error(`Usage: orch run --plan <path> --class <${Object.keys(CLASSES).join('|')}> [--model id --effort e [--harness h]] [--permission mode] [--packet file | --repair points.json | --continuation state.json] [--repo dir]`);
    if (klass && !CLASSES[klass]) console.error(`Unknown class: ${klass}`);
    return 2;
  }

  const repairArg = option(args, '--repair');
  const continuationArg = option(args, '--continuation');
  if (repairArg && continuationArg) {
    console.error('Use either --repair or --continuation, not both');
    return 2;
  }

  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const planPath = resolve(planArg);
  if (!existsSync(planPath)) {
    console.error(`Plan not found: ${planPath}`);
    return 1;
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
      return 1;
    }
    if (packetKind === 'repair' && !(Array.isArray(packetData.points) && packetData.points.length)) {
      console.error('The repair file needs a non-empty "points" list: [{file, line?, issue, expected?}]');
      return 1;
    }
  }

  try {
    const catalog = loadCatalog(ctx.stateDir);
    const config = loadConfig({ stateDir: ctx.stateDir });
    let entry;
    let effort = option(args, '--effort');
    let routing = null;

    const modelId = option(args, '--model');
    if (modelId) {
      entry = catalog.models.find((m) => m.id === modelId);
      if (!entry) throw new Error(`Unknown model: ${modelId}`);
      const harness = option(args, '--harness');
      if (harness && (harness !== entry.harness || HARNESS_OF_PREFIX[harness] === undefined)) {
        throw new Error(`Harness ${harness} does not match model ${modelId} (${entry.harness})`);
      }
      if (!entry.enabled) throw new Error(`Model ${modelId} is disabled`);
      effort = effort ?? entry.defaultEffort;
      if (!entry.allowedEfforts.includes(effort)) throw new Error(`effort ${effort} is not allowed for ${modelId} (allowed: ${entry.allowedEfforts.join(', ')})`);
    } else {
      const { decision, history } = await computeDecision({ klass, args, stateDir: ctx.stateDir });
      if (!decision.selected) throw new Error(`No eligible candidate for ${klass}\n${formatDecision(decision, { config, history })}`);
      entry = catalog.models.find((m) => m.id === decision.selected.id);
      effort = decision.selected.effort;
      routing = formatDecision(decision, { config, history });
    }

    const packetFile = option(args, '--packet');
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
      project: option(args, '--project'),
      title: option(args, '--title'),
    });
    console.log(JSON.stringify({ ...run, harness: entry.harness, model: entry.id, effort, routing }, null, 2));
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
