#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeJson } from './lib/config.mjs';
import { stateDir } from './lib/platform.mjs';
import { extractUsage, renderLine } from './lib/statusline.mjs';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const wrapped = sep === -1 ? [] : argv.slice(sep + 1);

let raw = '';
try {
  raw = await readStdin();
} catch {
  raw = '';
}

let usage = null;
try {
  usage = extractUsage(JSON.parse(raw));
} catch {
  usage = null;
}

if (usage) {
  try {
    writeJson(join(stateDir(), 'claude-usage.json'), { writtenAt: new Date().toISOString(), rate_limits: usage });
  } catch {}
}

let output = '';
if (wrapped.length) {
  const r = spawnSync(wrapped[0], wrapped.slice(1), { input: raw, encoding: 'utf8', shell: false, timeout: 5000 });
  if (!r.error && r.status === 0) output = r.stdout ?? '';
}
if (!output) output = renderLine(usage);
process.stdout.write(output);
process.exit(0);
