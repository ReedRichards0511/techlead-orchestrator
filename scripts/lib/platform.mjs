import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

const WIN_EXTS = ['.exe', '.com'];

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathDirs(env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const raw = key ? env[key] : '';
  return raw ? raw.split(delimiter).filter(Boolean) : [];
}

function candidatesIn(dir, name) {
  if (!isWindows) return [join(dir, name)];
  const lower = name.toLowerCase();
  if (WIN_EXTS.some((e) => lower.endsWith(e))) return [join(dir, name)];
  return WIN_EXTS.map((e) => join(dir, name + e));
}

function knownDirs(env) {
  const home = env.USERPROFILE || env.HOME || homedir();
  if (isWindows) {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(local, 'Microsoft', 'WinGet', 'Links'),
      join(local, 'devin', 'cli', 'bin'),
      join(local, 'Programs', 'OpenAI', 'Codex', 'bin'),
      join(local, 'agy', 'bin'),
    ];
  }
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.devin', 'bin')];
}

export function resolveExecutable(name, { env = process.env, overrides = {} } = {}) {
  const override = overrides[name];
  if (override && isFile(override)) return override;
  for (const dir of [...pathDirs(env), ...knownDirs(env)]) {
    for (const candidate of candidatesIn(dir, name)) {
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function stateDir({ home = homedir(), env = process.env } = {}) {
  if (env.ORCH_STATE_DIR) return env.ORCH_STATE_DIR;
  return join(home, '.claude', 'orchestrator');
}

export function skillDir({ home = homedir() } = {}) {
  return join(home, '.claude', 'skills', 'orchestrator');
}

export function cleanEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('CLAUDE')) continue;
    out[k] = v;
  }
  return out;
}

export function pathExists(p) {
  return existsSync(p);
}
