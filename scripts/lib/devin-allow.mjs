import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureExcluded, excludePath } from './safety.mjs';

const REL = join('.devin', 'config.local.json');
const PATTERN = '.devin/config.local.json';
const MARKER = 'devin-allow.json';

export function allowRulesFor(commands = []) {
  return [...new Set(commands.map((c) => c.trim()).filter(Boolean))].map((c) => `Exec(${c})`);
}

function readExclude(repo) {
  const file = excludePath(repo);
  return file && existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function decodeConfig(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    return { error: 'is not valid UTF-8' };
  }
  try {
    const config = JSON.parse(text.replace(/^﻿/, ''));
    if (!config || typeof config !== 'object' || Array.isArray(config)) return { error: 'is not a JSON object' };
    return { config };
  } catch {
    return { error: 'is not valid JSON' };
  }
}

export function applyDevinAllowlist({ repo, runDir, commands }) {
  const rules = allowRulesFor(commands);
  if (!rules.length) return { applied: false, reason: 'no validation commands in the plan' };

  restorePendingAllowlists(repo);

  const target = join(repo, REL);
  let original = null;
  let config = {};
  if (existsSync(target)) {
    original = readFileSync(target);
    const decoded = decodeConfig(original);
    if (decoded.error) return { applied: false, reason: `${REL} ${decoded.error}; left untouched` };
    config = decoded.config;
  }

  const createdDir = !existsSync(dirname(target));
  const allow = [...new Set([...(config.permissions?.allow ?? []), ...rules])];
  const next = { ...config, permissions: { ...(config.permissions ?? {}), allow } };

  const excludeBefore = readExclude(repo);
  const marker = {
    originalB64: original === null ? null : original.toString('base64'),
    createdDir,
    excludeBefore,
    excludeAdded: false,
    appliedAt: new Date().toISOString(),
  };
  writeFileSync(join(runDir, MARKER), JSON.stringify(marker));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(next, null, 2) + '\n');
  marker.excludeAdded = ensureExcluded(repo, PATTERN);
  writeFileSync(join(runDir, MARKER), JSON.stringify(marker));
  return { applied: true, rules, path: REL };
}

function withoutLine(text, pattern) {
  const lines = text.split(/(?<=\n)/);
  const at = lines.findIndex((l) => l.trim() === pattern);
  if (at === -1) return text;
  lines.splice(at, 1);
  return lines.join('');
}

function restoreExclude(repo, marker) {
  if (!marker.excludeAdded) return;
  const file = excludePath(repo);
  if (!file || !existsSync(file)) return;
  const current = readFileSync(file, 'utf8');
  const before = marker.excludeBefore ?? '';
  const appended = `${before && !before.endsWith('\n') ? '\n' : ''}${PATTERN}\n`;
  writeFileSync(file, current === before + appended ? before : withoutLine(current, PATTERN));
}

function originalOf(marker) {
  if (marker.originalB64 !== undefined) return marker.originalB64 === null ? null : Buffer.from(marker.originalB64, 'base64');
  return marker.original === null || marker.original === undefined ? null : Buffer.from(marker.original, 'utf8');
}

function removeIfEmpty(dir) {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir);
  } catch {
    return false;
  }
  return true;
}

export function restoreDevinAllowlist({ repo, runDir }) {
  const markerPath = join(runDir, MARKER);
  if (!existsSync(markerPath)) return false;
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  const original = originalOf(marker);
  const target = join(repo, REL);
  if (original === null) rmSync(target, { force: true });
  else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, original);
  }
  if (marker.createdDir) removeIfEmpty(dirname(target));
  restoreExclude(repo, marker);
  rmSync(markerPath, { force: true });
  return true;
}

export function restorePendingAllowlists(repo) {
  const runs = join(repo, '.orchestrator', 'runs');
  if (!existsSync(runs)) return [];
  const pending = [];
  for (const id of readdirSync(runs)) {
    const markerPath = join(runs, id, MARKER);
    if (!existsSync(markerPath)) continue;
    let appliedAt = '';
    try {
      appliedAt = JSON.parse(readFileSync(markerPath, 'utf8')).appliedAt ?? '';
    } catch {
      appliedAt = '';
    }
    pending.push({ id, appliedAt });
  }
  pending.sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  const restored = [];
  for (const { id } of pending) if (restoreDevinAllowlist({ repo, runDir: join(runs, id) })) restored.push(id);
  return restored;
}
