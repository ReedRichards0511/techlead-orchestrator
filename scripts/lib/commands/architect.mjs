import { join } from 'node:path';
import { deepMerge, loadConfig, readJson, writeJson } from '../config.mjs';
import { architectReport, formatArchitect, validateArchitectSettings } from '../architect.mjs';
import { option } from '../decide.mjs';

const USAGE = 'Usage: orch architect [--session-model <id>] [--session-effort <e>] [--json]\n       orch architect set [--model <m>] [--effort <e>] [--auditor <inherit|m>] [--enforce true|false]';

function setSettings(args, ctx) {
  const model = option(args, '--model');
  const effort = option(args, '--effort');
  const auditor = option(args, '--auditor');
  const enforce = option(args, '--enforce');
  if ([model, effort, auditor, enforce].every((v) => v === undefined)) {
    console.error(USAGE);
    return 2;
  }
  if (enforce !== undefined && !['true', 'false'].includes(enforce)) {
    console.error('Invalid --enforce: use true or false');
    return 2;
  }
  const invalid = validateArchitectSettings({ model, effort, auditor });
  if (invalid) {
    console.error(invalid);
    return 2;
  }
  const patch = {};
  if (model !== undefined || effort !== undefined || enforce !== undefined) {
    patch.architect = {};
    if (model !== undefined) patch.architect.model = model;
    if (effort !== undefined) patch.architect.effort = effort;
    if (enforce !== undefined) patch.architect.enforce = enforce === 'true';
  }
  if (auditor !== undefined) patch.subagents = { auditor: { model: auditor } };
  loadConfig({ stateDir: ctx.stateDir });
  const userPath = join(ctx.stateDir, 'config.json');
  writeJson(userPath, deepMerge(readJson(userPath, {}), patch));
  const report = architectReport(loadConfig({ stateDir: ctx.stateDir }));
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatArchitect(report));
  return 0;
}

export async function main(args, ctx) {
  if (args[0] === 'set') return setSettings(args.slice(1), ctx);
  const config = loadConfig({ stateDir: ctx.stateDir });
  const report = architectReport(config, {
    model: option(args, '--session-model'),
    effort: option(args, '--session-effort'),
  });
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatArchitect(report));
  return report.blocking ? 1 : 0;
}
