import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureExcluded } from './safety.mjs';

const REL = join('.devin', 'config.local.json');
const MARKER = 'devin-allow.json';

export function allowRulesFor(commands = []) {
  return [...new Set(commands.map((c) => c.trim()).filter(Boolean))].map((c) => `Exec(${c})`);
}

export function applyDevinAllowlist({ repo, runDir, commands }) {
  const rules = allowRulesFor(commands);
  if (!rules.length) return { applied: false, reason: 'no validation commands in the plan' };

  const target = join(repo, REL);
  let original = null;
  let config = {};
  if (existsSync(target)) {
    original = readFileSync(target, 'utf8');
    try {
      config = JSON.parse(original);
    } catch {
      return { applied: false, reason: `${REL} exists but is not valid JSON; left untouched` };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { applied: false, reason: `${REL} is not a JSON object; left untouched` };
  }

  const createdDir = !existsSync(dirname(target));
  const allow = [...new Set([...(config.permissions?.allow ?? []), ...rules])];
  const next = { ...config, permissions: { ...(config.permissions ?? {}), allow } };

  writeFileSync(join(runDir, MARKER), JSON.stringify({ original, createdDir }));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
  ensureExcluded(repo, '.devin/config.local.json');
  return { applied: true, rules, path: REL };
}

export function restoreDevinAllowlist({ repo, runDir }) {
  const markerPath = join(runDir, MARKER);
  if (!existsSync(markerPath)) return false;
  const { original, createdDir } = JSON.parse(readFileSync(markerPath, 'utf8'));
  const target = join(repo, REL);
  if (original === null) rmSync(target, { force: true });
  else writeFileSync(target, original);
  if (createdDir) {
    try {
      if (!readdirSync(dirname(target)).length) rmdirSync(dirname(target));
    } catch {
      // directory already gone or not empty: leave it
    }
  }
  rmSync(markerPath, { force: true });
  return true;
}
