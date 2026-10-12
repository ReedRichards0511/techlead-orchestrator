import { resolve } from 'node:path';
import { loadConfig } from '../config.mjs';
import { option } from '../decide.mjs';
import { runPostflight } from '../postflight.mjs';
import { positional } from './status.mjs';

export function formatPostflight(r) {
  const lines = [`POSTFLIGHT ${r.ok ? 'OK' : 'NOT OK'} for ${r.runId}`];
  if (r.classification) lines.push(`  run: ${r.classification.status} -> ${r.classification.action}`);
  lines.push(`  changed files: ${r.changedFiles.length}${r.changedFiles.length ? ` (${r.changedFiles.map((f) => f.path).join(', ')})` : ''}`);
  for (const v of r.violations) lines.push(`  [${v.severity.toUpperCase()}] ${v.code}: ${v.detail}`);
  for (const c of r.comments.slice(0, 10)) lines.push(`    comment ${c.file}:${c.line}: ${c.text}`);
  if (r.validation.skipped) lines.push('  validation: skipped');
  else {
    lines.push(`  validation: ${r.validation.regressions.length} regression(s), ${r.validation.preexisting.length} pre-existing failure(s), ${r.validation.fixed.length} fixed`);
    for (const x of r.validation.regressions) lines.push(`    - regression: ${x.command} (${x.reason})`);
  }
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (r.recovery.length) {
    lines.push('  Recovery (run manually, nothing was changed):');
    for (const c of r.recovery) lines.push(`    ${c}`);
  }
  return lines.join('\n');
}

export async function main(args, ctx) {
  const [runId] = positional(args);
  if (!runId) {
    console.error('Usage: orch postflight <runId> [--repo dir] [--skip-validate] [--json]');
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const config = loadConfig({ stateDir: ctx.stateDir });
  try {
    const r = await runPostflight({ repo, runId, config, skipValidate: args.includes('--skip-validate') });
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : formatPostflight(r));
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
