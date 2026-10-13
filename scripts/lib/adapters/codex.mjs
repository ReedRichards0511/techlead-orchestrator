import { slugFor } from '../catalog.mjs';

export function build({ entry, effort, packetPath, repo, config }) {
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
      ...(config?.permissions?.codex?.bypassSandbox === false
        ? ['--sandbox', 'workspace-write', '-c', 'approval_policy="never"']
        : ['--dangerously-bypass-approvals-and-sandbox']),
      '-C',
      repo,
      '-',
    ],
    stdinPath: packetPath,
    cwd: repo,
  };
}

export function parse({ stdout = '' }) {
  const out = { threadId: null, lastMessage: null, completed: false, errors: [], usage: null, sawEvents: false };
  const usages = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof ev.type === 'string') out.sawEvents = true;
    if (ev.type === 'thread.started') out.threadId = ev.thread_id ?? null;
    else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') out.lastMessage = ev.item.text ?? null;
    else if (ev.type === 'turn.completed') {
      out.completed = true;
      usages.push(ev.usage ?? null);
    } else if (ev.type === 'turn.failed') out.errors.push(ev.error?.message ?? 'turn failed');
    else if (ev.type === 'error') out.errors.push(ev.message ?? 'error');
  }
  if (usages.length) {
    const valid = n => Number.isSafeInteger(n) && n >= 0;
    const usage = {};
    for (const field of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
      const values = usages.map(u => u?.[field]);
      const known = values.filter(valid);
      const sum = known.reduce((a, b) => a + b, 0);
      if (known.length && valid(sum) && (known.length === values.length || ['input_tokens', 'output_tokens'].includes(field))) usage[field] = sum;
    }
    if (out.errors.length || usages.some(u => !valid(u?.input_tokens) || !valid(u?.output_tokens))) usage.partial = true;
    out.usage = Object.keys(usage).some(k => k !== 'partial') ? usage : null;
  }
  return out;
}
