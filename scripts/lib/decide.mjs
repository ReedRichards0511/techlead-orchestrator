import { join } from 'node:path';
import { loadConfig, readJson } from './config.mjs';
import { resolveExecutable } from './platform.mjs';
import { CLASSES, route } from './router.mjs';
import { loadHistory } from './history.mjs';
import { exhaustedProviders } from './quota/index.mjs';

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
  const stored = loadHistory(stateDir);
  const history = stored.aggregates;
  const workers = Object.fromEntries(['devin', 'codex', 'agy'].map((n) => [n, Boolean(resolveExecutable(n, { overrides }))]));

  const decision = route({
    klass,
    catalog,
    workers,
    history,
    bootstrap: stored.bootstrap,
    exclude: list(option(args, '--exclude')),
    exhaustedProviders: exhaustedProviders({ stateDir }),
  });
  return { decision, config, history, catalog };
}
