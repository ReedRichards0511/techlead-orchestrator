import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { buildRunRecord, formatHistory, loadHistory, recordRun, saveHistory } from '../history.mjs';
import { CLASSES } from '../router.mjs';
import { getStatus } from '../run.mjs';

const USAGE = 'Usage: orch history [--class C] [--json]\n       orch history record <runId> [--verdict PASS|REPAIR_REQUIRED] [--repairs N] [--repo dir] [--json]';

function record(args, ctx) {
  const runId = args[1];
  if (!runId || runId.startsWith('--')) {
    console.error(USAGE);
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const st = getStatus({ repo, runId });
  if (!st) {
    console.error(`Unknown run: ${runId}`);
    return 1;
  }
  const postflightPath = join(st.runDir, 'postflight.json');
  const postflight = existsSync(postflightPath) ? JSON.parse(readFileSync(postflightPath, 'utf8')) : null;
  const repairsArg = option(args, '--repairs');
  let entry;
  try {
    entry = buildRunRecord({
      status: st,
      verdict: option(args, '--verdict'),
      repairs: repairsArg === undefined ? 0 : Number(repairsArg),
      postflight,
    });
  } catch (e) {
    if (!e.usage) throw e;
    console.error(e.message);
    return 2;
  }
  const history = recordRun(loadHistory(ctx.stateDir), entry);
  saveHistory(ctx.stateDir, history);
  if (args.includes('--json')) console.log(JSON.stringify({ recorded: entry }, null, 2));
  else console.log(`Recorded ${entry.runId}: ${entry.class} ${entry.key} ${entry.status} verdict ${entry.verdict} (${entry.durationMin} min)`);
  return 0;
}

export async function main(args, ctx) {
  if (args[0] === 'record') return record(args, ctx);
  if (args[0] && !args[0].startsWith('--')) {
    console.error(`Unknown history subcommand: ${args[0]}\n${USAGE}`);
    return 2;
  }
  const klass = option(args, '--class');
  if (klass && !CLASSES[klass]) {
    console.error(`Unknown class: ${klass}`);
    return 2;
  }
  const history = loadHistory(ctx.stateDir);
  if (args.includes('--json')) {
    const aggregates = klass ? Object.fromEntries(Object.entries(history.aggregates).filter(([k]) => k.endsWith(`/${klass}`))) : history.aggregates;
    console.log(JSON.stringify({ aggregates, bootstrap: history.bootstrap, runs: klass ? history.runs.filter((r) => r.class === klass) : history.runs }, null, 2));
    return 0;
  }
  console.log(formatHistory(history, { config: loadConfig({ stateDir: ctx.stateDir }), klass }));
  return 0;
}
