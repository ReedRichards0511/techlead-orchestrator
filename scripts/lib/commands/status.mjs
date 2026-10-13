import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { getStatus } from '../run.mjs';

export function summarize(st) {
  const c = st.classification;
  const lines = [`${st.runId}  ${st.state}${st.lost ? ' (LOST: no heartbeat)' : ''}  elapsed ${st.elapsedSeconds}s`];
  if (st.meta) lines.push(`  ${st.meta.harness} / ${st.meta.model} @ ${st.meta.effort}  class ${st.meta.klass}`);
  if (c) lines.push(`  ${c.status}${c.phase ? ` (${c.phase})` : ''} -> ${c.action}: ${c.detail}`);
  if (st.usage) lines.push(`  Worker tokens (${st.usage.source}): total ${st.usage.totalTokens ?? 'UNKNOWN'} / prompt ${st.usage.promptTokens ?? 'UNKNOWN'} / cached ${st.usage.cachedTokens ?? 'UNKNOWN'} / completion ${st.usage.completionTokens ?? 'UNKNOWN'}`);
  return lines.join('\n');
}

export function positional(args) {
  const skip = new Set(['--repo', '--timeout']);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (skip.has(args[i])) i++;
    else if (!args[i].startsWith('--')) out.push(args[i]);
  }
  return out;
}

export async function main(args) {
  const [runId] = positional(args);
  if (!runId) {
    console.error('Usage: orch status <runId> [--repo dir] [--json]');
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const st = getStatus({ repo, runId });
  if (!st) {
    console.error(`Unknown run: ${runId}`);
    return 1;
  }
  console.log(args.includes('--json') ? JSON.stringify(st, null, 2) : summarize(st));
  return 0;
}
