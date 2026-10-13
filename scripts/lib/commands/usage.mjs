import { resolve } from 'node:path';
import { option } from '../decide.mjs';
import { formatUsage, reportUsage, startUsage } from '../usage.mjs';

export async function main(args) {
  const mode = args[0];
  const task = option(args, '--task');
  if (!['start', 'report'].includes(mode) || !task) {
    console.error('Usage: orch usage <start|report> --task <plan-id> [--session id] [--transcript file] [--repo dir] [--json]');
    return 2;
  }
  const opts = { repo: resolve(option(args, '--repo') ?? process.cwd()), task, session: option(args, '--session'), transcript: option(args, '--transcript') };
  const result = mode === 'start' ? startUsage(opts) : reportUsage(opts);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : mode === 'report' ? formatUsage(result) : `Token accounting started for ${task}${result.architectAvailable === false ? '; architect transcript unavailable' : ''}`);
  return 0;
}
