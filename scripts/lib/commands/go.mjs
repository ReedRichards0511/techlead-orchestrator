import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { runPostflight } from '../postflight.mjs';
import { waitRun } from '../run.mjs';
import { formatPostflight } from './postflight.mjs';
import { formatPreflight, preflightPlan } from './preflight.mjs';
import { launch } from './run.mjs';
import { summarize } from './status.mjs';

// One background call per worker run: preflight (first launch of a plan only), run, wait and postflight.
export async function main(args, ctx) {
  const planArg = option(args, '--plan');
  if (!planArg || !option(args, '--model') || !option(args, '--effort')) {
    console.error('Usage: orch go --plan <path> --class C --model id --effort e [--project-rules file] [--repair f | --continuation f | --allow-from runId] [--accept-dirty] [--repo dir]\nRun it once with Bash run_in_background and wait for its notification.');
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const planPath = resolve(planArg);
  const followUp = ['--repair', '--continuation', '--allow-from'].some((f) => option(args, f));
  // A second preflight would replace the baseline of partial work, so later launches of the same plan reuse its snapshot.
  if (!followUp && !existsSync(join(repo, '.orchestrator', 'snapshots', `${basename(planPath, '.md')}.json`))) {
    const pre = await preflightPlan({ args, ctx, repo, planPath });
    console.log(formatPreflight(pre));
    if (!pre.ok) return 1;
  }
  const run = await launch(args, ctx);
  if (run.code) return run.code;
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: Infinity });
  console.log(summarize(st));
  if (!['postflight', 'audit'].includes(st.classification?.action)) return 0;
  const r = await runPostflight({ repo, runId: run.runId, config: loadConfig({ stateDir: ctx.stateDir }) });
  console.log(formatPostflight(r));
  return r.ok ? 0 : 1;
}
