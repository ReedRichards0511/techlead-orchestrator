import { slugFor } from '../catalog.mjs';

export function build({ entry, effort, packetPath, repo }) {
  slugFor(entry, effort);
  if (effort === 'ultra') throw new Error('effort ultra is forbidden');
  return {
    exeName: 'codex',
    args: [
      'exec',
      '--json',
      '-m',
      entry.slugTemplate,
      '-c',
      `model_reasoning_effort="${effort}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '-C',
      repo,
      '-',
    ],
    stdinPath: packetPath,
    cwd: repo,
  };
}

export function parse({ stdout = '' }) {
  const out = { threadId: null, lastMessage: null, completed: false, errors: [], usage: null };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === 'thread.started') out.threadId = ev.thread_id ?? null;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') out.lastMessage = ev.item.text ?? null;
    else if (ev.type === 'turn.completed') {
      out.completed = true;
      out.usage = ev.usage ?? null;
    } else if (ev.type === 'turn.failed') out.errors.push(ev.error?.message ?? 'turn failed');
    else if (ev.type === 'error') out.errors.push(ev.message ?? 'error');
  }
  return out;
}
