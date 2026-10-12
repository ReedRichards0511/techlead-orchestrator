import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { bootstrapReport, endBootstrap, formatBootstrap, loadHistory, resetBootstrap, saveHistory } from '../history.mjs';

const USAGE = 'Usage: orch bootstrap status [--class C] [--json]\n       orch bootstrap end --class C [--promote <id@effort>]\n       orch bootstrap reset --class C';

export async function main(args, ctx) {
  const [sub] = args;
  if (!['status', 'end', 'reset'].includes(sub)) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig({ stateDir: ctx.stateDir });
  const classes = config.bootstrap?.classes ?? [];
  const klass = option(args, '--class');
  if (klass && !classes.includes(klass)) {
    console.error(`${klass} is not a bootstrap class (configured: ${classes.join(', ') || 'none'})`);
    return 2;
  }
  const history = loadHistory(ctx.stateDir);

  if (sub === 'status') {
    const reports = (klass ? [klass] : classes).map((c) => bootstrapReport(history, config, c));
    if (args.includes('--json')) console.log(JSON.stringify(klass ? reports[0] : reports, null, 2));
    else console.log(reports.map(formatBootstrap).join('\n\n'));
    return 0;
  }

  if (!klass) {
    console.error(`--class is required for bootstrap ${sub}\n${USAGE}`);
    return 2;
  }
  if (sub === 'end') {
    const promote = option(args, '--promote');
    let next;
    try {
      next = endBootstrap(history, klass, { promote, candidates: config.bootstrap?.candidates ?? [] });
    } catch (e) {
      if (!e.usage) throw e;
      console.error(e.message);
      return 2;
    }
    saveHistory(ctx.stateDir, next);
    console.log(`Bootstrap ended for ${klass}${promote ? `; ${promote} promoted to first option` : '; the order is unchanged'}.`);
    return 0;
  }
  saveHistory(ctx.stateDir, resetBootstrap(history, klass));
  console.log(`Bootstrap reset for ${klass}: counting restarts from now (aggregates are kept).`);
  return 0;
}
