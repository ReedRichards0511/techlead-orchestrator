#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from './lib/platform.mjs';

const COMMANDS = {
  doctor: 'Check OS, CLIs, auth, catalog and quota interfaces',
  models: 'Show or refresh the model catalog (refresh | enable | disable)',
  quota: 'Show quota dashboard (refresh | set)',
  route: 'Explain the routing decision without launching anything',
  preflight: 'git status, lock, snapshot and validation baseline',
  run: 'Build the packet and launch a worker in the background',
  status: 'Show the state of a run',
  wait: 'Block until a run finishes or times out',
  postflight: 'Deterministic checks, re-validation and error classification',
  history: 'Summarize local run history',
  bootstrap: 'Show, end or reset the bootstrap (status | end | reset)',
  unlock: 'Release an orphaned lock',
};

function help() {
  const lines = ['Usage: orch <command> [options]', '', 'Commands:'];
  for (const [name, desc] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(11)}${desc}`);
  lines.push('', 'All commands accept --json.');
  return lines.join('\n');
}

const [cmd, ...args] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(help());
  process.exit(0);
}

if (!(cmd in COMMANDS)) {
  console.error(`Unknown command: ${cmd}\n\n${help()}`);
  process.exit(2);
}

const handler = join(dirname(fileURLToPath(import.meta.url)), 'lib', 'commands', `${cmd}.mjs`);
let mod;
try {
  mod = await import(pathToFileURL(handler).href);
} catch (e) {
  if (e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(`${cmd}.mjs`)) {
    console.error(`Command "${cmd}" is not implemented yet`);
    process.exit(3);
  }
  throw e;
}

try {
  const code = await mod.main(args, { stateDir: stateDir() });
  process.exit(code ?? 0);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
