export const CLASSES = {
  SMALL_FIX: { estimatedMinutes: 15, reason: 'Cambio pequeño y localizado.' },
  BUG_SIMPLE: { estimatedMinutes: 20, reason: 'Causa conocida con un fix localizado.' },
  MECHANICAL_CHANGE: { estimatedMinutes: 30, reason: 'Cambio repetitivo entre varios archivos.' },
  TEST_GENERATION: { estimatedMinutes: 30, reason: 'Pruebas sobre código existente.' },
  REFACTOR: { estimatedMinutes: 45, reason: 'Reestructuración sin cambiar comportamiento.' },
  MIGRATION: { estimatedMinutes: 60, reason: 'Migración de versión, esquema o API.' },
  FEATURE: { estimatedMinutes: 60, reason: 'Funcionalidad nueva con un plan definido.' },
  CROSS_LAYER_FEATURE: {
    estimatedMinutes: 75,
    reason: 'Implementación que cruza capas y requiere un plan detallado.',
  },
  BUG_COMPLEX: { estimatedMinutes: 60, reason: 'Causa incierta o cambios entre varias capas.' },
  NATIVE_MOBILE: { estimatedMinutes: 75, reason: 'Trabajo nativo con herramientas de compilación Android/iOS.' },
  ARCHITECTURAL_IMPL: { estimatedMinutes: 90, reason: 'Implementación de la arquitectura definida en el plan.' },
};

const cand = (id, effort, tier, extra = {}) => ({ id, effort, tier, ...extra });
const SOL = (effort, tier, extra) => cand('devin/gpt-6-1-sol', effort, tier, extra);
const CODEX_SOL = (effort, tier) => cand('codex/gpt-6.1-sol', effort, tier);
const SONNET = (tier, effort = 'high') => cand('devin/claude-sonnet-5-5', effort, tier);
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
const GENERAL = [SOL('medium', 1), SWE2('high', 1), CODEX_SOL('medium', 2), SONNET(2, 'medium')];

export const CANDIDATES = {
  SMALL_FIX: SMALL,
  BUG_SIMPLE: SMALL,
  MECHANICAL_CHANGE: MECH,
  TEST_GENERATION: MECH,
  REFACTOR: GENERAL,
  MIGRATION: GENERAL,
  FEATURE: GENERAL,
  CROSS_LAYER_FEATURE: [SOL('medium', 1), SONNET(2), CODEX_SOL('medium', 2), SWE2('high', 3)],
  BUG_COMPLEX: [SOL('high', 1), SONNET(2), CODEX_SOL('high', 2), SWE2('high', 3)],
  NATIVE_MOBILE: [SOL('high', 1), CODEX_SOL('high', 1), SONNET(2), SWE2('high', 3)],
  ARCHITECTURAL_IMPL: [SOL('high', 1), CODEX_SOL('high', 1), SONNET(2), SWE2('high', 3)],
};

const PAY_RANK = { devin: 0, agy: 1, codex: 2 };
const HARNESS_NAMES = { devin: 'Devin', codex: 'Codex', agy: 'Antigravity' };
const REASONS = {
  'devin/gpt-6-1-sol': 'Implementador general; effort según la complejidad del plan.',
  'codex/gpt-6.1-sol': 'Sol en Codex; alternativa para implementar el mismo plan con otro harness.',
  'devin/swe-2': 'Especialista en tareas mecánicas; en cambios complejos exige un plan muy acotado.',
  'devin/claude-sonnet-5-5': 'Alternativa de la familia Claude para implementación y razonamiento entre capas.',
  'devin/claude-haiku-5-5': 'Alternativa para fixes pequeños y delimitados.',
  'devin/deepseek-v4-1-flash': 'Alternativa para cambios mecánicos y generación de pruebas.',
  'codex/gpt-6-luna': 'Alternativa en Codex para trabajo acotado, repetitivo o mecánico.',
  'agy/gemini-3.8-flash': 'Alternativa en Antigravity para tareas acotadas; High es el máximo permitido.',
};
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

export const isExternalFailure = (r) => EXTERNAL_FAILURES.has(r.status) && !(r.status === 'PERMISSION_FAILURE' && r.verdict && r.verdict !== 'FAILED');

export function countBootstrapRuns(runs, klass) {
  const counts = {};
  for (const r of runs) {
    if (r.class !== klass || isExternalFailure(r)) continue;
    counts[r.key] = (counts[r.key] ?? 0) + 1;
  }
  return counts;
}

function describe(c) {
  return `${HARNESS_NAMES[c.harness]} / ${c.displayName} / ${cap(c.effort)}`;
}

export function route({
  klass,
  catalog,
  workers = {},
  history = {},
  bootstrap = {},
  exclude = [],
  exhaustedProviders = [],
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
    if (exhaustedProviders.includes(entry.quotaBucket)) return skip(`worker reported a quota limit (${entry.quotaBucket})`);
    eligible.push({
      ...c,
      index,
      harness: entry.harness,
      displayName: entry.displayName,
      reason: REASONS[c.id],
    });
  });

  eligible.sort(
    (a, b) =>
      a.tier - b.tier ||
      PAY_RANK[a.harness] - PAY_RANK[b.harness] ||
      a.index - b.index,
  );

  let reason = spec.reason;
  for (let i = 0; i < eligible.length - 1; i++) {
    const a = eligible[i];
    const b = eligible[i + 1];
    if (a.tier !== b.tier) continue;
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
  const promotedKey = bootstrap.promoted?.[klass];
  if (promotedKey) {
    const at = eligible.findIndex((c) => keyOf(c) === promotedKey);
    if (at > 0 && eligible[at].tier === eligible[0].tier) {
      const [picked] = eligible.splice(at, 1);
      eligible.unshift(picked);
      notes.push(`${picked.displayName} promoted to first option for ${klass} after the bootstrap`);
      reason = `${reason} ${describe(picked)} was promoted to first option after the bootstrap.`;
    }
  }

  const options = eligible.slice(0, 4).map(({ index: _index, ...c }) => c);
  return {
    class: klass,
    recommended: options[0] ?? null,
    options,
    requiresSelection: true,
    planContradictionFallback: 'NONE',
    excluded,
    notes,
    reason,
    estimatedMinutes: spec.estimatedMinutes,
  };
}

export function workerQuestion(d) {
  if (!d.options.length) return null;
  const options = d.options.map((c, i) => ({
    label: `${describe(c)}${i === 0 ? ' (Recomendado)' : ''}`,
    description: i === 0 ? `${d.reason} ${c.reason}` : c.reason,
  }));
  if (options.length === 1) options.push({ label: 'No ejecutar', description: 'Dejar el plan pendiente sin lanzar un worker.' });
  return { questions: [{ question: '¿Con qué worker, modelo y effort quieres implementar este plan?', header: 'Worker', multiSelect: false, options }] };
}

export function formatDecision(d, { history = {} } = {}) {
  const lines = ['WORKER RECOMMENDATION', `Task class: ${d.class}`];
  if (!d.recommended) {
    lines.push('Recommended: none', 'Reason:     No eligible candidate.');
    for (const e of d.excluded) lines.push(`  - ${e.id} @ ${e.effort}: ${e.reason}`);
    return lines.join('\n');
  }
  const s = d.recommended;
  lines.push(`Recommended: ${describe(s)}`);
  lines.push(`Reason:     ${d.reason}`);
  const h = history[`${s.id}/${s.effort}/${d.class}`];
  lines.push(
    h ? `History:    ${h.runs} runs in this class · ${h.repairRequired ?? 0} repair${(h.repairRequired ?? 0) === 1 ? '' : 's'}` : 'History:    no runs yet in this class',
  );
  lines.push('Alternatives:');
  for (const c of d.options.slice(1)) lines.push(`  - ${describe(c)}: ${c.reason}`);
  if (d.options.length === 1) lines.push('  none available');
  lines.push('Awaiting user selection; no worker has been launched.');
  lines.push('PLAN_CONTRADICTION fallback: NONE → back to Opus');
  return lines.join('\n');
}
