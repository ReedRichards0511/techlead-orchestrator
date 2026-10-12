import { join } from 'node:path';
import { refreshCatalog, setEnabled } from '../catalog.mjs';
import { loadConfig, readJson, writeJson } from '../config.mjs';
import { capture } from '../proc.mjs';
import { resolveExecutable } from '../platform.mjs';

export function formatCatalog(cat) {
  const lines = [`Catalog generated ${cat.generatedAt}`, ''];
  lines.push('ID'.padEnd(34) + 'ENABLED'.padEnd(9) + 'EFFORTS (allowed)'.padEnd(34) + 'COST');
  for (const m of cat.models.filter((x) => x.enabled || x.new)) {
    const flag = m.new ? ' [NEW]' : '';
    lines.push(
      (m.id + flag).padEnd(34) +
        String(m.enabled).padEnd(9) +
        (m.allowedEfforts.join(',') || '-').padEnd(34) +
        (m.costTier ?? '-'),
    );
  }
  const disabled = cat.models.filter((m) => !m.enabled && !m.new).length;
  lines.push('', `${disabled} more models discovered but disabled.`);
  if (cat.missing?.length) lines.push(`Missing from CLI (pool): ${cat.missing.join(', ')}`);
  for (const e of cat.errors ?? []) lines.push(`Error (${e.harness}): ${e.message}`);
  return lines.join('\n');
}

export async function main(args, ctx) {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [sub, id, effortsArg] = rest;
  const catalogPath = join(ctx.stateDir, 'catalog.json');
  const config = loadConfig({ stateDir: ctx.stateDir });
  const out = (cat) => console.log(json ? JSON.stringify(cat, null, 2) : formatCatalog(cat));

  if (sub === 'refresh') {
    const overrides = config.platformOverrides?.paths ?? {};
    const paths = Object.fromEntries(['devin', 'codex', 'agy'].map((n) => [n, resolveExecutable(n, { overrides })]));
    const cat = await refreshCatalog({
      run: (exe, a) => capture(exe, a, { timeoutMs: 30000 }),
      stateDir: ctx.stateDir,
      paths,
    });
    out(cat);
    return cat.errors.length ? 1 : 0;
  }

  if (sub === 'enable' || sub === 'disable') {
    const cat = readJson(catalogPath, null);
    if (!cat) {
      console.error('No catalog yet. Run: orch models refresh');
      return 2;
    }
    if (!id) {
      console.error(`Usage: orch models ${sub} <id>${sub === 'enable' ? ' [efforts,comma,separated]' : ''}`);
      return 2;
    }
    try {
      const efforts = sub === 'enable' && effortsArg ? effortsArg.split(',').map((e) => e.trim()) : undefined;
      writeJson(catalogPath, setEnabled(cat, id, sub === 'enable', efforts));
      console.log(`${sub}d ${id}`);
      return 0;
    } catch (e) {
      console.error(e.message);
      return 1;
    }
  }

  if (sub === undefined) {
    const cat = readJson(catalogPath, null);
    if (!cat) {
      console.log('No catalog yet. Run: orch models refresh');
      return 0;
    }
    out(cat);
    return 0;
  }

  console.error(`Unknown models subcommand: ${sub}`);
  return 2;
}
