import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJson, writeJson } from './config.mjs';
import { countBootstrapRuns, isExternalFailure } from './router.mjs';
import { USAGE_FIELDS, USAGE_SOURCES } from './usage.mjs';

const NEVER_RAN = new Set(['QUOTA_EXHAUSTED', 'RATE_LIMITED', 'MODEL_UNAVAILABLE', 'PROVIDER_UNAVAILABLE']);
const VERDICTS = new Set(['PASS', 'REPAIR_REQUIRED', 'FAILED']);
const NEEDS_VERDICT = new Set(['SUCCESS', 'VALIDATION_FAILURE']);

const usageError = (message) => Object.assign(new Error(message), { usage: true });

export function emptyHistory() {
  return { aggregates: {}, runs: [], bootstrap: { ended: {}, resetAt: {}, promoted: {} } };
}

export function loadHistory(stateDir) {
  let stored = null;
  try {
    stored = readJson(join(stateDir, 'history.json'), null);
  } catch {
    stored = null;
  }
  const base = emptyHistory();
  if (!stored || typeof stored !== 'object') return base;
  return {
    aggregates: Array.isArray(stored.runs) ? aggregateRuns(stored.runs) : stored.aggregates ?? base.aggregates,
    runs: Array.isArray(stored.runs) ? stored.runs : base.runs,
    bootstrap: { ...base.bootstrap, ...(stored.bootstrap ?? {}) },
  };
}

export function saveHistory(stateDir, history) {
  writeJson(join(stateDir, 'history.json'), history);
}

const round = (n, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;
const sum = (list, pick) => list.reduce((n, x) => n + pick(x), 0);
const splitKey = (key) => {
  const at = key.lastIndexOf('@');
  return { id: key.slice(0, at), effort: key.slice(at + 1) };
};

export function buildRunRecord({ status, verdict, repairs = 0, postflight = null, now = new Date() }) {
  const cls = status?.classification;
  if (!cls) throw new Error(`Run ${status?.runId ?? ''} has not finished (state: ${status?.state ?? 'unknown'}); record it after it ends`);
  if (!Number.isInteger(repairs) || repairs < 0) throw usageError(`--repairs must be a non-negative integer (got ${repairs})`);
  const needs = NEEDS_VERDICT.has(cls.status);
  const mayAudit = needs || cls.status === 'PERMISSION_FAILURE';
  if (needs && !verdict) throw usageError(`A ${cls.status} run needs --verdict PASS|REPAIR_REQUIRED`);
  const final = verdict ?? 'FAILED';
  if (!VERDICTS.has(final)) throw usageError(`Invalid verdict: ${verdict} (expected PASS, REPAIR_REQUIRED or FAILED)`);
  if (!mayAudit && final !== 'FAILED') throw usageError(`Invalid verdict ${final} for a ${cls.status} run: it can only be FAILED`);
  if (final === 'PASS' && postflight?.ok === false) throw usageError('Cannot record PASS while postflight is NOT OK; resolve blocking findings and rerun postflight');
  const meta = status.meta ?? {};
  const started = new Date(status.startedAt);
  const ended = new Date(status.endedAt ?? now);
  const violations = postflight?.violations ?? [];
  const usage = {};
  if (USAGE_SOURCES[meta.harness] && status.usage?.source === USAGE_SOURCES[meta.harness]) {
    for (const key of USAGE_FIELDS) {
      const value = status.usage[key];
      if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    }
  }
  return {
    runId: status.runId,
    class: meta.klass,
    key: `${meta.model}@${meta.effort}`,
    status: cls.status,
    verdict: final,
    repairs,
    durationMin: round(Math.max(0, ended - started) / 60000, 1),
    planHash: meta.planPath ? createHash('sha256').update(meta.planPath).digest('hex').slice(0, 12) : null,
    problem: repairs > 0 || cls.status === 'VALIDATION_FAILURE' || final === 'REPAIR_REQUIRED',
    scopeFlags: violations.filter((v) => (v.code === 'SOFT_SCOPE_VIOLATION' || v.code === 'OUT_OF_SCOPE')).length,
    commentFlags: postflight?.comments?.length ?? 0,
    permissionRetry: (cls.status === 'PERMISSION_FAILURE' && final !== 'FAILED') || meta.permission === 'dangerous' || Boolean(meta.allowlistRetryOf),
    ...(Object.keys(usage).length ? { usage: { source: USAGE_SOURCES[meta.harness], ...usage, ...(status.usage.partial === true ? { partial: true } : {}) } } : {}),
    date: now.toISOString().slice(0, 10),
    at: now.toISOString(),
  };
}

export function aggregateRuns(runs) {
  const groups = {};
  for (const r of runs) {
    if (NEVER_RAN.has(r.status)) continue;
    const { id, effort } = splitKey(r.key);
    (groups[`${id}/${effort}/${r.class}`] ??= []).push(r);
  }
  const out = {};
  for (const [key, list] of Object.entries(groups)) {
    const count = (f) => list.filter(f).length;
    out[key] = {
      runs: list.length,
      success: count((r) => r.verdict === 'PASS' && (r.status === 'SUCCESS' || r.status === 'PERMISSION_FAILURE')),
      repairRequired: count((r) => r.verdict === 'REPAIR_REQUIRED'),
      planContradictions: count((r) => r.status === 'PLAN_CONTRADICTION' || r.priorStatuses?.includes('PLAN_CONTRADICTION')),
      executionFailures: count((r) => r.status === 'EXECUTION_FAILURE'),
      validationFailures: count((r) => r.status === 'VALIDATION_FAILURE'),
      permissionRetries: count((r) => r.permissionRetry),
      problemRuns: count((r) => (r.repairs ?? 0) > 0 || (r.problem ?? (r.status === 'VALIDATION_FAILURE' || r.verdict === 'REPAIR_REQUIRED'))),
      repairCount: sum(list, (r) => r.repairs ?? 0),
      avgRepairCount: round(sum(list, (r) => r.repairs ?? 0) / list.length, 2),
      avgDurationMin: round(sum(list, (r) => r.durationMin ?? 0) / list.length),
      lastRun: list.map((r) => r.date).sort().at(-1),
    };
  }
  return out;
}

function mergeRecords(prior, record) {
  const priorIds = prior.runIds ?? [prior.runId];
  return {
    ...record,
    runIds: [...priorIds, record.runId],
    priorStatuses: [...new Set([...(prior.priorStatuses ?? []), prior.status])],
    repairs: Math.max(prior.repairs ?? 0, record.repairs ?? 0),
    durationMin: round((prior.durationMin ?? 0) + (record.durationMin ?? 0), 1),
    scopeFlags: Math.max(prior.scopeFlags ?? 0, record.scopeFlags ?? 0),
    commentFlags: Math.max(prior.commentFlags ?? 0, record.commentFlags ?? 0),
    permissionRetry: Boolean(prior.permissionRetry || record.permissionRetry),
    problem: Boolean(prior.problem || record.problem),
    date: prior.date ?? record.date,
  };
}

export function recordRun(history, record) {
  const holder = history.runs.find((r) => (r.runIds ?? [r.runId]).includes(record.runId));
  const sameTask = (r) => record.planHash && r.planHash === record.planHash && r.key === record.key;
  let runs;
  if (holder && holder.runId !== record.runId) return history;
  if (holder) {
    const ids = holder.runIds ?? [holder.runId];
    const next =
      ids.length > 1
        ? { ...record, runIds: ids, priorStatuses: holder.priorStatuses, repairs: Math.max(holder.repairs ?? 0, record.repairs ?? 0), durationMin: holder.durationMin, permissionRetry: Boolean(holder.permissionRetry || record.permissionRetry), problem: Boolean(holder.problem || record.problem), date: holder.date }
        : record;
    runs = history.runs.map((r) => (r === holder ? next : r));
  } else {
    const prior = history.runs.find(sameTask);
    runs = prior ? history.runs.map((r) => (r === prior ? mergeRecords(prior, record) : r)) : [...history.runs, record];
  }
  return { ...history, runs, aggregates: aggregateRuns(runs) };
}

export function bootstrapRuns(history, klass) {
  const since = history.bootstrap?.resetAt?.[klass];
  return history.runs.filter((r) => r.class === klass && (!since || r.at > since));
}

export function bootstrapState(history, config) {
  return {
    counts: Object.fromEntries((config.bootstrap?.classes ?? []).map((c) => [c, countBootstrapRuns(bootstrapRuns(history, c), c)])),
    ended: history.bootstrap?.ended ?? {},
    promoted: history.bootstrap?.promoted ?? {},
  };
}

export function endBootstrap(history, klass, { promote, candidates } = {}) {
  if (promote && candidates && !candidates.includes(promote)) {
    throw usageError(`${promote} is not a bootstrap candidate (expected one of ${candidates.join(', ')})`);
  }
  const next = structuredClone(history);
  next.bootstrap.ended[klass] = true;
  if (promote) next.bootstrap.promoted[klass] = promote;
  return next;
}

export function resetBootstrap(history, klass, now = new Date()) {
  const next = structuredClone(history);
  delete next.bootstrap.ended[klass];
  delete next.bootstrap.promoted[klass];
  next.bootstrap.resetAt[klass] = now.toISOString();
  return next;
}

export function bootstrapReport(history, config, klass) {
  const boot = config.bootstrap ?? {};
  const keys = boot.candidates ?? [];
  const runsPerClass = boot.runsPerClass ?? 10;
  const active = Boolean(boot.enabled) && (boot.classes ?? []).includes(klass);
  const counted = bootstrapRuns(history, klass).filter((r) => !isExternalFailure(r) && keys.includes(r.key));
  const perKey = {};
  for (const key of keys) {
    const list = counted.filter((r) => r.key === key);
    const n = list.length;
    const passNoRepair = list.filter((r) => (r.status === 'SUCCESS' || r.status === 'PERMISSION_FAILURE') && r.verdict === 'PASS' && (r.repairs ?? 0) === 0).length;
    perKey[key] = {
      runs: n,
      passNoRepair,
      passNoRepairRate: n ? round(passNoRepair / n, 2) : 0,
      avgRepairs: n ? round(sum(list, (r) => r.repairs ?? 0) / n, 2) : 0,
      scopeFlags: sum(list, (r) => r.scopeFlags ?? 0),
      commentFlags: sum(list, (r) => r.commentFlags ?? 0),
      validationFailures: list.filter((r) => r.status === 'VALIDATION_FAILURE').length,
      avgDurationMin: n ? round(sum(list, (r) => r.durationMin ?? 0) / n, 1) : 0,
    };
  }
  const total = sum(keys, (k) => perKey[k].runs);
  const ended = Boolean(history.bootstrap?.ended?.[klass]);
  const complete = active && (ended || total >= runsPerClass);
  const [first, second] = keys.map((k) => perKey[k]);
  let recommendation = 'NOT_APPLICABLE';
  if (active) {
    if (!complete) recommendation = 'IN_PROGRESS';
    else if (!first || !second || first.runs === 0 || second.runs === 0) recommendation = 'INSUFFICIENT_DATA';
    else {
      const scopeRate = (m) => m.scopeFlags / m.runs;
      recommendation = second.passNoRepairRate >= first.passNoRepairRate && scopeRate(second) <= scopeRate(first) ? 'PROMOTE_SWE2' : 'KEEP_SOL';
    }
  }
  return {
    class: klass,
    active,
    ended,
    complete,
    total,
    runsPerClass,
    keys,
    perKey,
    recommendation,
    promoted: history.bootstrap?.promoted?.[klass] ?? null,
    needsConfirmation: boot.askBeforeReorder !== false,
  };
}

export function devinUsage(history, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const weekStart = new Date(now.getTime() - 6 * 86400000).toISOString().slice(0, 10);
  const out = { today: {}, week: {} };
  for (const r of history.runs) {
    if (!r.key.startsWith('devin/') || NEVER_RAN.has(r.status)) continue;
    const model = splitKey(r.key).id;
    const add = (bucket) => {
      const slot = (bucket[model] ??= { runs: 0, minutes: 0 });
      slot.runs += 1;
      slot.minutes = round(slot.minutes + (r.durationMin ?? 0), 1);
    };
    if (r.date === today) add(out.today);
    if (r.date >= weekStart && r.date <= today) add(out.week);
  }
  return out;
}

function pad(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
}

export function formatBootstrap(report) {
  if (!report.active) return `Bootstrap is not active for ${report.class}.`;
  const lines = [`Bootstrap ${report.total}/${report.runsPerClass} for ${report.class}${report.ended ? ' (ended)' : ''}`];
  const rows = [['candidate', 'runs', 'pass w/o repair', 'avg repairs', 'scope flags', 'comments', 'val. failures', 'avg min']];
  for (const key of report.keys) {
    const m = report.perKey[key];
    rows.push([key, m.runs, `${m.passNoRepair}/${m.runs}`, m.avgRepairs, m.scopeFlags, m.commentFlags, m.validationFailures, m.avgDurationMin]);
  }
  lines.push(...pad(rows).map((l) => `  ${l}`));
  const [sol, swe] = report.keys;
  const messages = {
    IN_PROGRESS: 'Recommendation: IN_PROGRESS. Collect user-approved runs; no automatic alternation.',
    INSUFFICIENT_DATA: 'Recommendation: INSUFFICIENT_DATA. One candidate has no counted runs; no reorder is justified.',
    KEEP_SOL: `Recommendation: KEEP_SOL. ${swe} does not match ${sol}. Close with: orch bootstrap end --class ${report.class}`,
    PROMOTE_SWE2: `Recommendation: PROMOTE_SWE2. ${swe} matches or beats ${sol} with no more scope flags. Confirm with Reed before reordering, then: orch bootstrap end --class ${report.class} --promote ${swe}`,
  };
  lines.push(messages[report.recommendation] ?? `Recommendation: ${report.recommendation}`);
  if (report.promoted) lines.push(`Promoted to first option: ${report.promoted}`);
  return lines.join('\n');
}

export function formatHistory(history, { config = {}, klass, now = new Date() } = {}) {
  const entries = Object.entries(history.aggregates).filter(([k]) => !klass || k.endsWith(`/${klass}`));
  const lines = [];
  if (!entries.length) {
    lines.push(klass ? `No runs recorded for ${klass}.` : 'No runs recorded yet.');
  } else {
    const total = sum(entries, ([, a]) => a.runs);
    lines.push(`History${klass ? ` for ${klass}` : ''}: ${total} run${total === 1 ? '' : 's'} recorded`);
    const rows = [['key', 'runs', 'success', 'repair', 'val.fail', 'plan', 'exec', 'avg rep', 'avg min', 'last']];
    for (const [k, a] of entries.sort(([x], [y]) => x.localeCompare(y))) {
      rows.push([k, a.runs, a.success, a.repairRequired, a.validationFailures, a.planContradictions, a.executionFailures, a.avgRepairCount, a.avgDurationMin, a.lastRun]);
    }
    lines.push(...pad(rows));
  }
  const classes = klass ? [klass] : (config.bootstrap?.classes ?? []);
  for (const c of classes) {
    const report = bootstrapReport(history, config, c);
    if (!report.active) continue;
    if (!klass && report.total === 0 && !report.ended) continue;
    lines.push('', formatBootstrap(report));
  }
  const usage = devinUsage(history, { now });
  if (!klass && Object.keys(usage.week).length) {
    const fmt = (b) => Object.entries(b).map(([m, v]) => `${m} ${v.runs} run${v.runs === 1 ? '' : 's'} / ${v.minutes} min`).join(', ') || 'none';
    lines.push('', `Devin local accounting: today ${fmt(usage.today)} · last 7 days ${fmt(usage.week)}`);
  }
  const runs = history.runs.filter(r => !klass || r.class === klass);
  if (runs.some(r => r.usage)) {
    const rows = [['run', 'prompt', 'cached', 'completion', 'total', 'source']];
    for (const r of runs) rows.push([r.runId, r.usage?.promptTokens ?? 'UNKNOWN', r.usage?.cachedTokens ?? 'UNKNOWN', r.usage?.completionTokens ?? 'UNKNOWN', r.usage?.totalTokens ?? 'UNKNOWN', r.usage?.source ?? 'UNKNOWN']);
    lines.push('', 'Worker tokens by run (task totals and architect: orch usage report):', ...pad(rows));
  }
  return lines.join('\n');
}
