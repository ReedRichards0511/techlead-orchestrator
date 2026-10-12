import { slugFor } from '../catalog.mjs';

export function build({ entry, effort, packetPath, repo }) {
  slugFor(entry, effort);
  if (!entry.efforts.includes(effort)) throw new Error(`effort ${effort} is not available for ${entry.id}`);
  const instruction = `Read and follow the implementation packet at ${packetPath}. Do not ask questions.`;
  return {
    exeName: 'agy',
    args: [
      '--model',
      entry.slugTemplate,
      '--effort',
      effort,
      '--dangerously-skip-permissions',
      '--output-format',
      'stream-json',
      '--print-timeout',
      '0',
      `--print=${instruction}`,
    ],
    stdinPath: null,
    cwd: repo,
  };
}

function toResult(obj) {
  return {
    status: obj.status ?? null,
    response: obj.response ?? '',
    error: obj.error ?? '',
    deniedActions: obj.denied_actions ?? [],
    usage: obj.usage ?? null,
  };
}

export function parse({ stdout = '' }) {
  for (const line of stdout.split(/\r?\n/).reverse()) {
    if (!line.trim().startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.event === 'result' && obj.result) return toResult(obj.result);
    if (obj.event === undefined && 'status' in obj) return toResult(obj);
  }
  return { status: null, response: '', error: '', deniedActions: [], usage: null };
}
