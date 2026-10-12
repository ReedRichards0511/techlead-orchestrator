import { levelFor, unknownQuota } from './quota/normalize.mjs';

export const CLASSES = {
  SMALL_FIX: { estimatedMinutes: 15, reason: 'Small, localized change. SWE-2 is fast and takes few steps on this kind of work.' },
  BUG_SIMPLE: { estimatedMinutes: 20, reason: 'Known cause with a localized fix. SWE-2 handles it with little exploration.' },
  MECHANICAL_CHANGE: { estimatedMinutes: 30, reason: 'Repetitive change across many files. SWE-2 High keeps edits consistent and cheap.' },
  TEST_GENERATION: { estimatedMinutes: 30, reason: 'Tests over existing code. SWE-2 High is efficient for this pattern.' },
  REFACTOR: { estimatedMinutes: 45, reason: 'Restructuring without behavior change. Sol Medium is the general implementer.' },
  MIGRATION: { estimatedMinutes: 60, reason: 'Version or API migration. Sol Medium is the general implementer.' },
  FEATURE: { estimatedMinutes: 60, reason: 'New functionality with a detailed plan. Sol Medium is the general implementer.' },
  CROSS_LAYER_FEATURE: {
    estimatedMinutes: 75,
    reason: 'Cross-layer implementation with a very detailed plan. Sol Medium gives strong reasoning without overthinking. Devin is preferred over Codex at equal quality.',
  },
  BUG_COMPLEX: { estimatedMinutes: 60, reason: 'Uncertain cause across layers. Sol High reasons best here.' },
  NATIVE_MOBILE: { estimatedMinutes: 75, reason: 'Native mobile work with heavy shell and build tooling. Sol High is the most reliable.' },
  ARCHITECTURAL_IMPL: { estimatedMinutes: 90, reason: 'Implements a new architecture defined by Opus. Sol High with the strongest scope discipline.' },
};

const cand = (id, effort, tier, extra = {}) => ({ id, effort, tier, ...extra });
const SOL = (effort, tier, extra) => cand('devin/gpt-6-1-sol', effort, tier, extra);
const CODEX_SOL = (effort, tier) => cand('codex/gpt-6.1-sol', effort, tier);
const SONNET = (tier) => cand('devin/claude-sonnet-5-5', 'high', tier);
const SWE2 = (effort, tier, extra) => cand('devin/swe-2', effort, tier, extra);

const SMALL = [
  SWE2('medium', 1),
  cand('devin/deepseek-v4-1-flash', 'high', 2),
  cand('devin/claude-haiku-5-5', 'medium', 2),
  cand('agy/gemini-3.8-flash', 'high', 3),
  cand('codex/gpt-6-luna', 'high', 3),
];
const MECH = [
  SWE2('high', 1),
  cand('devin/deepseek-v4-1-flash', 'max', 2),
  cand('agy/gemini-3.8-flash', 'high', 3),
  cand('codex/gpt-6-luna', 'max', 3),
];
const GENERAL = [SOL('medium', 1), SWE2('high', 1), CODEX_SOL('medium', 2)];

export const CANDIDATES = {
  SMALL_FIX: SMALL,
  BUG_SIMPLE: SMALL,
  MECHANICAL_CHANGE: MECH,
  TEST_GENERATION: MECH,
  REFACTOR: GENERAL,
  MIGRATION: GENERAL,
  FEATURE: GENERAL,
  CROSS_LAYER_FEATURE: [SOL('medium', 1), SONNET(2), CODEX_SOL('medium', 2)],
  BUG_COMPLEX: [SOL('high', 1), SONNET(2), CODEX_SOL('high', 2)],
  NATIVE_MOBILE: [SOL('high', 1), CODEX_SOL('high', 1), SONNET(2)],
  ARCHITECTURAL_IMPL: [SOL('high', 1), CODEX_SOL('high', 1)],
};

const PAY_RANK = { devin: 0, agy: 1, codex: 2 };
const HARNESS_NAMES = { devin: 'Devin', codex: 'Codex', agy: 'Antigravity' };
const BUCKET_NAMES = { devin: 'Devin', codex: 'Codex', antigravity: 'Antigravity' };
const CRITICAL_DROP_SECONDS = 24 * 3600;
const HISTORY_MIN_RUNS = 5;
const HISTORY_GAP_POINTS = 25;
export const EXTERNAL_FAILURES = new Set([
  'PLAN_CONTRADICTION',
  'EXECUTION_FAILURE',
  'QUOTA_EXHAUSTED',
  'RATE_LIMITED',
  'TIMEOUT',
  'MODEL_UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'PERMISSION_FAILURE',
]);

const keyOf = (c) => `${c.id}@${c.effort}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const failureRate = (h) => (h.problemRuns ?? (h.repairRequired ?? 0) + (h.validationFailures ?? 0)) / h.runs * 100;

export function countBootstrapRuns(runs, klass) {
  const counts = {};
  for (const r of runs) {
    if (r.class !== klass || EXTERNAL_FAILURES.has(r.status)) continue;
    counts[r.key] = (counts[r.key] ?? 0) + 1;
  }
  return counts;
}

function limitingResetSeconds(quota) {
  const windows = Object.values(quota.windows).filter((w) => typeof w === 'object');
  if (!windows.length) return null;
  return windows.reduce((a, b) => (b.remainingPercent < a.remainingPercent ? b : a)).resetInSeconds;
}

function describe(c) {
  return `${HARNESS_NAMES[c.harness]} / ${c.displayName} / ${cap(c.effort)}`;
}

export function route({
  klass,
  catalog,
  quotas,
  config,
  workers = {},
  history = {},
  bootstrap = { counts: {}, ended: {} },
  exclude = [],
  allowProtected = [],
}) {
  const spec = CLASSES[klass];
  if (!spec) throw new Error(`Unknown task class: ${klass}`);

  const excluded = [];
  const notes = [];
  const eligible = [];

  CANDIDATES[klass].forEach((c, index) => {
    const entry = catalog.models.find((m) => m.id === c.id);
    const skip = (reason) => excluded.push({ id: c.id, effort: c.effort, reason });
    if (!entry) return skip('not in catalog');
    if (!entry.enabled) return skip('model disabled');
    if (!entry.allowedEfforts.includes(c.effort)) return skip(`effort ${c.effort} not allowed`);
    if (workers[entry.harness] === false) return skip(`${entry.harness} CLI unavailable`);
    if (exclude.includes(keyOf(c))) return skip('excluded after a failure');
    const quota = quotas[entry.quotaBucket] ?? unknownQuota(entry.quotaBucket);
    if (quota.health === 'EXHAUSTED') return skip(`quota exhausted (${entry.quotaBucket})`);

    let drop = false;
    if (quota.health === 'CRITICAL') {
      const reset = limitingResetSeconds(quota);
      const beforeEnd = reset !== null && reset < spec.estimatedMinutes * 60;
      drop = !beforeEnd && (reset === null || reset > CRITICAL_DROP_SECONDS);
      if (drop) notes.push(`${entry.quotaBucket} quota is CRITICAL with a far reset: ${entry.displayName} dropped one tier`);
    }
    const protectedFlag = quota.health === 'PROTECTED' && !allowProtected.includes(entry.quotaBucket);
    eligible.push({
      ...c,
      index,
      harness: entry.harness,
      displayName: entry.displayName,
      bucket: entry.quotaBucket,
      quotaHealth: quota.health,
      effTier: c.tier + (drop ? 1 : 0),
      protected: protectedFlag,
    });
  });

  eligible.sort(
    (a, b) =>
      a.effTier - b.effTier ||
      Number(a.protected) - Number(b.protected) ||
      PAY_RANK[a.harness] - PAY_RANK[b.harness] ||
      a.index - b.index,
  );

  for (const c of eligible) {
    if (c.protected && eligible.length === 1) notes.push(`${c.bucket} is PROTECTED (below weekly reserve) but there is no alternative`);
  }

  let reason = spec.reason;
  const boot = config.bootstrap ?? {};
  const bootKeys = boot.candidates ?? [];
  const bootCounts = bootstrap.counts?.[klass] ?? {};
  const bootTotal = bootKeys.reduce((n, k) => n + (bootCounts[k] ?? 0), 0);
  const bootActive =
    boot.enabled && (boot.classes ?? []).includes(klass) && !bootstrap.ended?.[klass] && bootTotal < (boot.runsPerClass ?? 10);

  if (bootActive) {
    const pool = bootKeys.map((k) => eligible.find((c) => keyOf(c) === k)).filter(Boolean);
    if (pool.length >= 2) {
      const pick = pool.reduce((best, c) => ((bootCounts[keyOf(c)] ?? 0) < (bootCounts[keyOf(best)] ?? 0) ? c : best));
      eligible.splice(eligible.indexOf(pick), 1);
      eligible.unshift(pick);
      const detail = pool.map((c) => `${c.displayName} ${bootCounts[keyOf(c)] ?? 0} runs`).join(', ');
      reason = `Bootstrap ${bootTotal}/${boot.runsPerClass} for ${klass}: alternating ${pool.map(describe).join(' ⇄ ')} (${detail})`;
    }
  } else {
    for (let i = 0; i < eligible.length - 1; i++) {
      const a = eligible[i];
      const b = eligible[i + 1];
      if (a.effTier !== b.effTier) continue;
      const ha = history[`${a.id}/${a.effort}/${klass}`];
      const hb = history[`${b.id}/${b.effort}/${klass}`];
      if (!ha || ha.runs < HISTORY_MIN_RUNS || !hb || hb.runs < 1) continue;
      const gap = failureRate(ha) - failureRate(hb);
      if (gap >= HISTORY_GAP_POINTS) {
        eligible[i] = b;
        eligible[i + 1] = a;
        notes.push(`${a.id} demoted by history: failure rate ${Math.round(failureRate(ha))}% vs ${Math.round(failureRate(hb))}% for ${b.id}`);
        i++;
      }
    }
  }

  const promotedKey = bootstrap.promoted?.[klass];
  if (promotedKey && !bootActive) {
    const at = eligible.findIndex((c) => keyOf(c) === promotedKey);
    if (at > 0 && !eligible[at].protected && eligible[at].effTier === eligible[0].effTier) {
      const [picked] = eligible.splice(at, 1);
      eligible.unshift(picked);
      notes.push(`${picked.displayName} promoted to first option for ${klass} after the bootstrap`);
      reason = `${reason} ${describe(picked)} was promoted to first option after the bootstrap.`;
    }
  }

  const quotaUnknown = [...new Set(eligible.filter((c) => (quotas[c.bucket]?.health ?? 'UNKNOWN') === 'UNKNOWN').map((c) => c.bucket))];
  if (eligible[0]?.protected) notes.push(`${eligible[0].bucket} is PROTECTED (below weekly reserve); selected for lack of a better option`);
  if (notes.length) reason = `${reason} ${notes.filter((n) => /CRITICAL/.test(n)).join('. ')}`.trim();

  return {
    class: klass,
    selected: eligible[0] ?? null,
    fallback: eligible[1] ?? null,
    planContradictionFallback: 'NONE',
    ranked: eligible,
    excluded,
    notes,
    quotaUnknown,
    quotas,
    reason,
    estimatedMinutes: spec.estimatedMinutes,
  };
}

function shortDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(0, Math.floor(seconds / 60))}m`;
}

const WINDOW_LABELS = { short: '5h', daily: 'daily', weekly: 'weekly' };

function quotaLine(bucket, quota, config) {
  const name = BUCKET_NAMES[bucket] ?? bucket;
  const rows = Object.entries(quota.windows).filter(([, w]) => typeof w === 'object');
  if (!rows.length) return `${name} quota unknown`;
  const parts = rows.map(
    ([k, w]) =>
      `${WINDOW_LABELS[k]} ${levelFor(w.remainingPercent, config.thresholds)} (${Math.round(w.remainingPercent)}%, reset ${shortDuration(w.resetInSeconds)})`,
  );
  return `${name} ${parts.join(' · ')} [source: ${quota.source}]`;
}

export function formatDecision(d, { config, history = {} }) {
  const lines = ['ROUTING DECISION', `Task class: ${d.class}`];
  if (!d.selected) {
    lines.push('Selected:   none', 'Reason:     No eligible candidate.');
    for (const e of d.excluded) lines.push(`  - ${e.id} @ ${e.effort}: ${e.reason}`);
    return lines.join('\n');
  }
  const s = d.selected;
  lines.push(`Selected:   ${describe(s)}`);
  lines.push(`Reason:     ${d.reason}`);
  const q = d.quotas[s.bucket] ?? unknownQuota(s.bucket);
  lines.push(`Quota:      ${quotaLine(s.bucket, q, config)}`);
  const h = history[`${s.id}/${s.effort}/${d.class}`];
  lines.push(
    h ? `History:    ${h.runs} runs in this class · ${h.repairRequired ?? 0} repair${(h.repairRequired ?? 0) === 1 ? '' : 's'}` : 'History:    no runs yet in this class',
  );
  if (d.fallback) {
    const f = d.fallback;
    const fq = d.quotas[f.bucket] ?? unknownQuota(f.bucket);
    const w = fq.windows.weekly;
    const detail = typeof w === 'object' ? `${f.bucket} weekly ${levelFor(w.remainingPercent, config.thresholds)} ${Math.round(w.remainingPercent)}%` : `${f.bucket} quota unknown`;
    lines.push(`Fallback if execution failure: ${describe(f)} (${detail})`);
  } else {
    lines.push('Fallback if execution failure: none available');
  }
  lines.push('PLAN_CONTRADICTION fallback: NONE → back to Opus');
  return lines.join('\n');
}
