import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir as defaultStateDir } from './platform.mjs';

const DEFAULTS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.defaults.json');

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function loadConfig({ stateDir = defaultStateDir() } = {}) {
  mkdirSync(stateDir, { recursive: true });
  const userPath = join(stateDir, 'config.json');
  if (!existsSync(userPath)) copyFileSync(DEFAULTS_PATH, userPath);
  const defaults = JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8'));
  let user;
  try {
    user = JSON.parse(readFileSync(userPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid config.json at ${userPath}: ${e.message}`);
  }
  return deepMerge(defaults, user);
}
