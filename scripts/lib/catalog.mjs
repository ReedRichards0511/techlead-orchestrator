import { join } from 'node:path';
import { readJson, writeJson } from './config.mjs';

export const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const FORBIDDEN_EFFORTS = ['ultra'];

export const POOL = [
  { id: 'devin/swe-2', efforts: ['medium', 'high', 'max'], defaultEffort: 'medium' },
  { id: 'devin/gpt-6-1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'devin/claude-sonnet-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'devin/claude-haiku-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'devin/deepseek-v4-1-flash', efforts: ['high', 'max'], defaultEffort: 'high' },
  { id: 'codex/gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
  { id: 'codex/gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'agy/gemini-3.8-flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
];

const BUCKETS = { devin: 'devin', codex: 'codex', agy: 'antigravity' };

const sortEfforts = (list) => [...new Set(list)].sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));

function costTier(summary) {
  if (!summary) return 'free';
  const input = /\$([\d.]+) \/ 1M Input/.exec(summary);
  const output = /\$([\d.]+) \/ 1M Output/.exec(summary);
  return input && output ? `$${input[1]}/$${output[1]}` : summary;
}

export function parseDevinModels(json) {
  const out = [];
  for (const fam of json.families ?? []) {
    const uid = fam.family_uid;
    const efforts = [];
    let plain = null;
    let cost;
    for (const v of fam.variants ?? []) {
      const rest = v.model_uid === uid ? '' : v.model_uid.startsWith(`${uid}-`) ? v.model_uid.slice(uid.length + 1) : null;
      if (rest === null) continue;
      if (rest === '') plain = v;
      else if (EFFORT_ORDER.includes(rest)) {
        efforts.push(rest);
        if (cost === undefined) cost = v.cost_summary ?? null;
      }
    }
    if (cost === undefined) cost = (plain ?? fam.variants?.[0])?.cost_summary ?? null;
    const sorted = sortEfforts(efforts);
    out.push({
      id: `devin/${uid}`,
      harness: 'devin',
      provider: null,
      displayName: fam.family_label,
      slugTemplate: sorted.length ? `${uid}-{effort}` : uid,
      efforts: sorted,
      defaultEffort: null,
      contextWindow: null,
      costTier: costTier(cost),
      visible: true,
    });
  }
  return out;
}

export function parseCodexModels(json) {
  return (json.models ?? []).map((m) => ({
    id: `codex/${m.slug}`,
    harness: 'codex',
    provider: 'openai',
    displayName: m.display_name,
    slugTemplate: m.slug,
    efforts: sortEfforts((m.supported_reasoning_levels ?? []).map((l) => l.effort)),
    defaultEffort: m.default_reasoning_level ?? null,
    contextWindow: m.context_window ?? null,
    costTier: null,
    visible: m.visibility === 'list',
  }));
}

export function parseAgyModels(text) {
  const groups = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [slug, label = slug] = line.split('\t');
    const m = /^(.*)-(high|medium|low)$/.exec(slug.trim());
    const base = m ? m[1] : slug.trim();
    const g = groups.get(base) ?? { efforts: [], label: label.replace(/\s*\((High|Medium|Low)\)\s*$/, '') };
    if (m) g.efforts.push(m[2]);
    groups.set(base, g);
  }
  return [...groups].map(([base, g]) => ({
    id: `agy/${base}`,
    harness: 'agy',
    provider: null,
    displayName: g.label,
    slugTemplate: base,
    efforts: sortEfforts(g.efforts),
    defaultEffort: null,
    contextWindow: null,
    costTier: null,
    visible: true,
  }));
}

export function buildCatalog({ discovered, previous, pool = POOL, now = new Date() }) {
  const prevMap = new Map((previous?.models ?? []).map((m) => [m.id, m]));
  const poolMap = new Map(pool.map((p) => [p.id, p]));
  const seen = new Set();
  const models = discovered.map((d) => {
    seen.add(d.id);
    const p = poolMap.get(d.id);
    const prev = prevMap.get(d.id);
    const candidate = prev ? prev.allowedEfforts : p ? p.efforts : [];
    const allowedEfforts = sortEfforts(candidate.filter((e) => d.efforts.includes(e) && !FORBIDDEN_EFFORTS.includes(e)));
    return {
      ...d,
      allowedEfforts,
      defaultEffort: p?.defaultEffort ?? d.defaultEffort ?? null,
      quotaBucket: BUCKETS[d.harness],
      enabled: prev ? prev.enabled : Boolean(p),
      new: previous ? (prev ? prev.new === true : true) : false,
      lastValidated: now.toISOString().slice(0, 10),
    };
  });
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: 1,
    generatedAt: now.toISOString(),
    models,
    missing: pool.map((p) => p.id).filter((id) => !seen.has(id)),
    errors: [],
  };
}

export function setEnabled(catalog, id, enabled, efforts) {
  const model = catalog.models.find((m) => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);
  if (efforts) {
    for (const e of efforts) {
      if (FORBIDDEN_EFFORTS.includes(e)) throw new Error(`effort ${e} is forbidden`);
      if (!model.efforts.includes(e)) throw new Error(`effort ${e} is not available for ${id}`);
    }
  }
  const allowedEfforts = efforts
    ? sortEfforts(efforts)
    : model.allowedEfforts.length
      ? model.allowedEfforts
      : sortEfforts(model.efforts.filter((e) => !FORBIDDEN_EFFORTS.includes(e)));
  return {
    ...catalog,
    models: catalog.models.map((m) => (m.id === id ? { ...m, enabled, allowedEfforts, new: false } : m)),
  };
}

export function slugFor(entry, effort) {
  if (entry.efforts.length && !entry.efforts.includes(effort)) {
    throw new Error(`effort ${effort} is not available for ${entry.id}`);
  }
  if (entry.harness === 'devin') return entry.slugTemplate.replace('{effort}', effort);
  return entry.slugTemplate;
}

const SOURCES = [
  { harness: 'devin', args: ['models', 'list', '--format', 'json'], parse: (s) => parseDevinModels(JSON.parse(s)) },
  { harness: 'codex', args: ['debug', 'models'], parse: (s) => parseCodexModels(JSON.parse(s)) },
  { harness: 'agy', args: ['models'], parse: (s) => parseAgyModels(s) },
];

export async function refreshCatalog({ run, stateDir, paths, now = new Date() }) {
  const catalogPath = join(stateDir, 'catalog.json');
  const previous = readJson(catalogPath, null);
  const errors = [];
  const results = await Promise.all(
    SOURCES.map(async (src) => {
      const exe = paths[src.harness];
      if (!exe) {
        errors.push({ harness: src.harness, message: 'executable not found' });
        return null;
      }
      try {
        let r = await run(exe, src.args);
        if (r.timedOut) r = await run(exe, src.args);
        if (r.status !== 0) throw new Error(`exit ${r.status}`);
        return src.parse(r.stdout);
      } catch (e) {
        errors.push({ harness: src.harness, message: e.message });
        return null;
      }
    }),
  );
  const discovered = [];
  SOURCES.forEach((src, i) => {
    if (results[i]) discovered.push(...results[i]);
    else discovered.push(...(previous?.models ?? []).filter((m) => m.harness === src.harness));
  });
  const catalog = buildCatalog({ discovered, previous, now });
  catalog.errors = errors;
  writeJson(catalogPath, catalog);
  return catalog;
}
