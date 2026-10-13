import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { waitRun } from '../run.mjs';
import { positional, summarize } from './status.mjs';

export async function main(args) {
  const [runId] = positional(args);
  if (!runId) {
    console.error('Usage: orch wait <runId> [--until-ended | --timeout seconds] [--repo dir] [--json]');
    return 2;
  }
  const repo = resolve(option(args, '--repo') ?? process.cwd());
  const seconds = Number(option(args, '--timeout') ?? 100);
  if (!args.includes('--until-ended') && (!Number.isFinite(seconds) || seconds <= 0)) { console.error('--timeout must be a positive number'); return 2; }
  try {
    const st = await waitRun({ repo, runId, timeoutMs: args.includes('--until-ended') ? Infinity : seconds * 1000 });
    console.log(args.includes('--json') ? JSON.stringify(st, null, 2) : `${summarize(st)}${st.waiting ? '\n  still running: call wait again' : ''}`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  }
}
