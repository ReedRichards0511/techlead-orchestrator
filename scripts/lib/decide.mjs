import { join } from 'node:path';
import { loadConfig, readJson } from './config.mjs';
import { resolveExecutable } from './platform.mjs';
import { CLASSES, route } from './router.mjs';
import { bootstrapState, loadHistory } from './history.mjs';
import { getAllQuotas } from './quota/index.mjs';
import { fetchCodexQuota } from './quota/codex.mjs';
import { readClaudeUsage } from './quota/claude.mjs';

const REFRESH_CLASSES = new Set(['FEATURE', 'CROSS_LAYER_FEATURE', 'BUG_COMPLEX', 'NATIVE_MOBILE', 'ARCHITECTURAL_IMPL']);

export function option(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export function list(value) {
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

export function loadCatalog(stateDir) {
  const catalog = readJson(join(stateDir, 'catalog.json'), null);
  if (!catalog) throw new Error('No catalog yet. Run: orch models refresh');
  return catalog;
}

export async function computeDecision({ klass, args = [], stateDir }) {
  if (!CLASSES[klass]) throw new Error(`Unknown class: ${klass}`);
  const catalog = loadCatalog(stateDir);
  const config = loadConfig({ stateDir });
  const overrides = config.platformOverrides?.paths ?? {};
  const codexExe = resolveExecutable('codex', { overrides });
  const deps = {
    fetchCodex: (o) => (codexExe ? fetchCodexQuota({ exe: codexExe, ...o }) : Promise.reject(new Error('codex not found'))),
    readClaude: (o) => readClaudeUsage({ file: join(stateDir, 'claude-usage.json'), ...o }),
    fetchDevin: null,
  };
  const quotas = await getAllQuotas({
    stateDir,
    config,
    now: new Date(),
    deps,
    refresh: REFRESH_CLASSES.has(klass) || args.includes('--refresh-quota'),
    estimatedMinutes: CLASSES[klass].estimatedMinutes,
  });

  const stored = loadHistory(stateDir);
  const bootstrap = bootstrapState(stored, config);
  const history = stored.aggregates;
  const workers = Object.fromEntries(['devin', 'codex', 'agy'].map((n) => [n, Boolean(resolveExecutable(n, { overrides }))]));

  const decision = route({
    klass,
    catalog,
    quotas,
    config,
    workers,
    history,
    bootstrap,
    exclude: list(option(args, '--exclude')),
    allowProtected: list(option(args, '--allow-protected')),
  });
  return { decision, config, history, catalog };
}
