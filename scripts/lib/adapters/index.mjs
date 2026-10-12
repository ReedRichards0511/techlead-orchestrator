import * as devin from './devin.mjs';
import * as codex from './codex.mjs';
import * as agy from './agy.mjs';

const ADAPTERS = { devin, codex, agy };

function adapter(harness) {
  const a = ADAPTERS[harness];
  if (!a) throw new Error(`No adapter for harness: ${harness}`);
  return a;
}

export function buildInvocation(opts) {
  return adapter(opts.entry.harness).build(opts);
}

export function parseOutput(harness, io) {
  return adapter(harness).parse(io);
}
