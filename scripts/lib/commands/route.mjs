import { computeDecision, option } from '../decide.mjs';
import { CLASSES, formatDecision, workerQuestion } from '../router.mjs';

export function formatExplain(d) {
  const lines = ['', 'Candidates (best first):'];
  d.options.forEach((c, i) => {
    lines.push(`  ${i + 1}. ${c.id} @ ${c.effort}  tier ${c.tier}: ${c.reason}`);
  });
  if (d.excluded.length) {
    lines.push('', 'Excluded:');
    for (const e of d.excluded) lines.push(`  - ${e.id} @ ${e.effort}: ${e.reason}`);
  }
  if (d.notes.length) {
    lines.push('', 'Notes:');
    for (const n of d.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}

export async function main(args, ctx) {
  const klass = option(args, '--class');
  if (!klass || !CLASSES[klass]) {
    console.error(`Usage: orch route --class <${Object.keys(CLASSES).join('|')}> [--exclude key,key] [--explain] [--json]`);
    if (klass) console.error(`Unknown class: ${klass}`);
    return 2;
  }
  let result;
  try {
    result = await computeDecision({ klass, args, stateDir: ctx.stateDir });
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const { decision, config, history } = result;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...decision, question: workerQuestion(decision) }, null, 2));
  } else {
    console.log(formatDecision(decision, { config, history }));
    if (args.includes('--explain')) console.log(formatExplain(decision));
  }
  return decision.recommended ? 0 : 1;
}
