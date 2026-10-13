import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateRuns,
  bootstrapReport,
  bootstrapState,
  bootstrapRuns,
  buildRunRecord,
  devinUsage,
  emptyHistory,
  endBootstrap,
  formatBootstrap,
  formatHistory,
  loadHistory,
  recordRun,
  resetBootstrap,
  saveHistory,
} from '../lib/history.mjs';

const SOL = 'devin/gpt-6-1-sol@medium';
const SWE = 'devin/swe-2@high';
const NOW = new Date('2026-10-12T15:00:00Z');

function status({ klass = 'FEATURE', model = 'devin/swe-2', effort = 'high', cls = 'SUCCESS', permission = 'smart', minutes = 12 } = {}) {
  return {
    runId: 'p1-20261012T150000',
    state: 'exited',
    startedAt: '2026-10-12T14:48:00.000Z',
    endedAt: new Date(new Date('2026-10-12T14:48:00.000Z').getTime() + minutes * 60000).toISOString(),
    meta: { harness: 'devin', model, effort, klass, permission, planId: 'p1', planPath: 'C:\\Users\\someone\\repo\\.orchestrator\\plans\\p1.md' },
    classification: { status: cls, phase: null, action: 'postflight', detail: 'x' },
  };
}

const rec = (over = {}) => ({
  runId: `r${Math.random()}`,
  class: 'FEATURE',
  key: SWE,
  status: 'SUCCESS',
  verdict: 'PASS',
  repairs: 0,
  durationMin: 10,
  scopeFlags: 0,
  commentFlags: 0,
  permissionRetry: false,
  date: '2026-10-12',
  at: '2026-10-12T15:00:00.000Z',
  ...over,
});

test('a task that passes after repairs still counts against the model problem rate', () => {
  const record = buildRunRecord({ status: status(), verdict: 'PASS', repairs: 2, now: NOW });
  assert.equal(record.problem, true);
  const agg = aggregateRuns([{ ...record, problem: false }])['devin/swe-2/high/FEATURE'];
  assert.equal(agg.problemRuns, 1);
  assert.equal(agg.success, 1);
});

test('loading old history rebuilds aggregates that missed repairs on successful tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-history-repair-'));
  const record = rec({ repairs: 1, problem: false });
  saveHistory(dir, { ...emptyHistory(), runs: [record], aggregates: { 'devin/swe-2/high/FEATURE': { runs: 1, problemRuns: 0 } } });
  assert.equal(loadHistory(dir).aggregates['devin/swe-2/high/FEATURE'].problemRuns, 1);
});

test('buildRunRecord keeps only the allowed fields and no absolute paths', () => {
  const r = buildRunRecord({ status: status(), verdict: 'PASS', now: NOW });
  assert.deepEqual(Object.keys(r).sort(), ['at', 'class', 'commentFlags', 'date', 'durationMin', 'key', 'permissionRetry', 'planHash', 'problem', 'repairs', 'runId', 'scopeFlags', 'status', 'verdict']);
  assert.equal(r.key, SWE);
  assert.equal(r.class, 'FEATURE');
  assert.equal(r.durationMin, 12);
  assert.equal(r.date, '2026-10-12');
  assert.doesNotMatch(JSON.stringify(r), /Users|someone|plans/);
});

test('history keeps only valid worker counters and displays missing counters as UNKNOWN', () => {
  const st = { ...status(), usage: { source: 'devin-export', promptTokens: 100, completionTokens: 0, cachedTokens: -1, account: 'private-account' } };
  const r = buildRunRecord({ status: st, verdict: 'PASS', now: NOW });
  assert.deepEqual(r.usage, { source: 'devin-export', promptTokens: 100, completionTokens: 0 });
  assert.doesNotMatch(JSON.stringify(r), /private/);
  const text = formatHistory(recordRun(emptyHistory(), r));
  assert.match(text, /100\s+UNKNOWN\s+0/);
  assert.equal(buildRunRecord({ status: { ...st, usage: { promptTokens: 100 } }, verdict: 'PASS' }).usage, undefined);
});

test('history preserves Codex and Antigravity counters with their verified source and partial flag', () => {
  for (const [harness, source] of [['codex', 'codex-jsonl'], ['agy', 'agy-result']]) {
    const st = status({ model: `${harness}/fake` });
    st.meta.harness = harness;
    st.usage = { source, totalTokens: 120, partial: true, privateField: 'secret' };
    const record = buildRunRecord({ status: st, verdict: 'PASS', now: NOW });
    assert.deepEqual(record.usage, { source, totalTokens: 120, partial: true });
    assert.ok(!JSON.stringify(record).includes('secret'));
  }
});

test('buildRunRecord counts scope and comment flags from the postflight', () => {
  const postflight = {
    violations: [
      { code: 'OUT_OF_SCOPE', severity: 'flag', detail: 'secret detail' },
      { code: 'OUT_OF_SCOPE', severity: 'flag' },
      { code: 'WHITESPACE_ONLY', severity: 'flag' },
      { code: 'NEW_COMMENT', severity: 'flag' },
    ],
    comments: [{ file: 'a.ts', line: 3, text: 'code text must not be stored' }],
  };
  const r = buildRunRecord({ status: status(), verdict: 'PASS', postflight, now: NOW });
  assert.equal(r.scopeFlags, 2);
  assert.equal(r.commentFlags, 1);
  assert.doesNotMatch(JSON.stringify(r), /secret|code text/);
});

test('a failed deterministic postflight cannot be recorded as PASS', () => {
  assert.throws(() => buildRunRecord({ status: status(), verdict: 'PASS', postflight: { ok: false, violations: [{ code: 'DELETED_OUT_OF_PLAN', severity: 'grave' }] } }), /postflight is NOT OK/);
  assert.equal(buildRunRecord({ status: status(), verdict: 'REPAIR_REQUIRED', postflight: { ok: false } }).verdict, 'REPAIR_REQUIRED');
});

test('buildRunRecord needs a verdict for SUCCESS and VALIDATION_FAILURE', () => {
  assert.throws(() => buildRunRecord({ status: status(), now: NOW }), /verdict/i);
  assert.throws(() => buildRunRecord({ status: status({ cls: 'VALIDATION_FAILURE' }), now: NOW }), /verdict/i);
  assert.throws(() => buildRunRecord({ status: status(), verdict: 'MAYBE', now: NOW }), /verdict/i);
});

test('buildRunRecord defaults a failed run to FAILED and rejects PASS for it', () => {
  const r = buildRunRecord({ status: status({ cls: 'PLAN_CONTRADICTION' }), now: NOW });
  assert.equal(r.verdict, 'FAILED');
  assert.equal(r.status, 'PLAN_CONTRADICTION');
  assert.throws(() => buildRunRecord({ status: status({ cls: 'PLAN_CONTRADICTION' }), verdict: 'PASS', now: NOW }), /verdict/i);
});

test('buildRunRecord refuses unfinished runs and invalid repair counts', () => {
  const running = { ...status(), state: 'running', classification: undefined };
  assert.throws(() => buildRunRecord({ status: running, verdict: 'PASS', now: NOW }), /not finished/i);
  assert.throws(() => buildRunRecord({ status: status(), verdict: 'PASS', repairs: -1, now: NOW }), /repairs/i);
  assert.throws(() => buildRunRecord({ status: status(), verdict: 'PASS', repairs: 'x', now: NOW }), /repairs/i);
});

test('buildRunRecord marks a dangerous-permission run as a permission retry', () => {
  const r = buildRunRecord({ status: status({ permission: 'dangerous' }), verdict: 'PASS', now: NOW });
  assert.equal(r.permissionRetry, true);
});

test('aggregateRuns follows the section 21 shape per harness/model/effort/class', () => {
  const runs = [
    rec({ verdict: 'PASS', durationMin: 10 }),
    rec({ verdict: 'REPAIR_REQUIRED', repairs: 2, durationMin: 20 }),
    rec({ status: 'VALIDATION_FAILURE', verdict: 'FAILED', durationMin: 30 }),
    rec({ status: 'PLAN_CONTRADICTION', verdict: 'FAILED', durationMin: 4 }),
    rec({ status: 'EXECUTION_FAILURE', verdict: 'FAILED', durationMin: 6 }),
    rec({ permissionRetry: true, durationMin: 10, date: '2026-10-13' }),
  ];
  const agg = aggregateRuns(runs)['devin/swe-2/high/FEATURE'];
  assert.equal(agg.runs, 6);
  assert.equal(agg.success, 2);
  assert.equal(agg.repairRequired, 1);
  assert.equal(agg.validationFailures, 1);
  assert.equal(agg.planContradictions, 1);
  assert.equal(agg.executionFailures, 1);
  assert.equal(agg.permissionRetries, 1);
  assert.equal(agg.avgRepairCount, 0.33);
  assert.equal(agg.avgDurationMin, 13);
  assert.equal(agg.lastRun, '2026-10-13');
  assert.equal(agg.problemRuns, 2);
});

test('aggregateRuns counts a validation failure that needed repair once in problemRuns', () => {
  const agg = aggregateRuns([rec({ status: 'VALIDATION_FAILURE', verdict: 'REPAIR_REQUIRED', repairs: 1 })])['devin/swe-2/high/FEATURE'];
  assert.equal(agg.validationFailures, 1);
  assert.equal(agg.repairRequired, 1);
  assert.equal(agg.problemRuns, 1);
});

test('aggregateRuns ignores runs where the worker never really ran', () => {
  const runs = [rec(), rec({ status: 'QUOTA_EXHAUSTED', verdict: 'FAILED' }), rec({ status: 'RATE_LIMITED', verdict: 'FAILED' }), rec({ status: 'MODEL_UNAVAILABLE', verdict: 'FAILED' }), rec({ status: 'PROVIDER_UNAVAILABLE', verdict: 'FAILED' })];
  assert.equal(aggregateRuns(runs)['devin/swe-2/high/FEATURE'].runs, 1);
});

test('recordRun is idempotent per runId and rebuilds the aggregates', () => {
  let h = emptyHistory();
  h = recordRun(h, rec({ runId: 'a', verdict: 'PASS' }));
  h = recordRun(h, rec({ runId: 'a', verdict: 'REPAIR_REQUIRED', repairs: 1 }));
  assert.equal(h.runs.length, 1);
  const agg = h.aggregates['devin/swe-2/high/FEATURE'];
  assert.equal(agg.runs, 1);
  assert.equal(agg.repairRequired, 1);
  assert.equal(agg.success, 0);
});

test('saveHistory/loadHistory round-trip atomically and tolerate a missing or corrupt file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-h-'));
  assert.deepEqual(loadHistory(dir), emptyHistory());
  const h = recordRun(emptyHistory(), rec({ runId: 'a' }));
  saveHistory(dir, h);
  assert.deepEqual(loadHistory(dir), h);
  assert.equal(existsSync(join(dir, 'history.json.tmp')), false);
  writeFileSync(join(dir, 'history.json'), '{not json');
  assert.deepEqual(loadHistory(dir), emptyHistory());
});

test('loadHistory fills missing sections of an older file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-h-'));
  writeFileSync(join(dir, 'history.json'), JSON.stringify({ runs: [rec({ runId: 'a' })] }));
  const h = loadHistory(dir);
  assert.deepEqual(h.bootstrap, { ended: {}, resetAt: {}, promoted: {} });
  assert.equal(h.aggregates['devin/swe-2/high/FEATURE'].runs, 1);
  assert.equal(h.runs.length, 1);
});

test('bootstrapRuns only returns runs of the class recorded after a reset', () => {
  let h = emptyHistory();
  h = recordRun(h, rec({ runId: 'old', at: '2026-10-10T10:00:00.000Z' }));
  h = recordRun(h, rec({ runId: 'new', at: '2026-10-12T10:00:00.000Z' }));
  h = recordRun(h, rec({ runId: 'other', class: 'REFACTOR', at: '2026-10-12T10:00:00.000Z' }));
  assert.equal(bootstrapRuns(h, 'FEATURE').length, 2);
  h = resetBootstrap(h, 'FEATURE', new Date('2026-10-11T00:00:00Z'));
  assert.deepEqual(bootstrapRuns(h, 'FEATURE').map((r) => r.runId), ['new']);
  assert.equal(bootstrapRuns(h, 'REFACTOR').length, 1);
});

test('resetBootstrap clears ended and promoted but keeps the aggregates', () => {
  let h = recordRun(emptyHistory(), rec({ runId: 'a' }));
  h = endBootstrap(h, 'FEATURE', { promote: SWE });
  assert.equal(h.bootstrap.ended.FEATURE, true);
  assert.equal(h.bootstrap.promoted.FEATURE, SWE);
  h = resetBootstrap(h, 'FEATURE', NOW);
  assert.equal(h.bootstrap.ended.FEATURE, undefined);
  assert.equal(h.bootstrap.promoted.FEATURE, undefined);
  assert.equal(h.aggregates['devin/swe-2/high/FEATURE'].runs, 1);
});

test('endBootstrap rejects a promote key that is not a bootstrap candidate when candidates are given', () => {
  assert.throws(() => endBootstrap(emptyHistory(), 'FEATURE', { promote: 'devin/other@high', candidates: [SOL, SWE] }), /candidate/i);
  const h = endBootstrap(emptyHistory(), 'FEATURE', { promote: SOL, candidates: [SOL, SWE] });
  assert.equal(h.bootstrap.promoted.FEATURE, SOL);
});

const CONFIG = { bootstrap: { enabled: true, classes: ['REFACTOR', 'MIGRATION', 'FEATURE'], candidates: [SOL, SWE], runsPerClass: 10, askBeforeReorder: true } };

function filled({ sol, swe }) {
  let h = emptyHistory();
  let n = 0;
  for (const r of sol) h = recordRun(h, rec({ runId: `s${n++}`, key: SOL, ...r }));
  for (const r of swe) h = recordRun(h, rec({ runId: `w${n++}`, key: SWE, ...r }));
  return h;
}
const pass = (n, over = {}) => Array.from({ length: n }, () => ({ ...over }));

test('bootstrapReport counts runs and excludes external failures', () => {
  const h = filled({ sol: [...pass(2), { status: 'QUOTA_EXHAUSTED', verdict: 'FAILED' }, { status: 'PLAN_CONTRADICTION', verdict: 'FAILED' }], swe: pass(1) });
  const rep = bootstrapReport(h, CONFIG, 'FEATURE');
  assert.equal(rep.total, 3);
  assert.equal(rep.perKey[SOL].runs, 2);
  assert.equal(rep.perKey[SWE].runs, 1);
  assert.equal(rep.complete, false);
  assert.equal(rep.recommendation, 'IN_PROGRESS');
});

test('bootstrapReport computes the metrics of section 9.5', () => {
  const h = filled({
    sol: [{ verdict: 'PASS', durationMin: 20 }, { verdict: 'REPAIR_REQUIRED', repairs: 2, durationMin: 40, scopeFlags: 1, commentFlags: 2 }],
    swe: [{ verdict: 'PASS', durationMin: 10 }, { status: 'VALIDATION_FAILURE', verdict: 'FAILED', durationMin: 30 }],
  });
  const sol = bootstrapReport(h, CONFIG, 'FEATURE').perKey[SOL];
  assert.equal(sol.passNoRepair, 1);
  assert.equal(sol.passNoRepairRate, 0.5);
  assert.equal(sol.avgRepairs, 1);
  assert.equal(sol.scopeFlags, 1);
  assert.equal(sol.commentFlags, 2);
  assert.equal(sol.avgDurationMin, 30);
  const swe = bootstrapReport(h, CONFIG, 'FEATURE').perKey[SWE];
  assert.equal(swe.validationFailures, 1);
  assert.equal(swe.avgDurationMin, 20);
});

test('a complete bootstrap recommends SWE-2 when it matches Sol without more scope flags', () => {
  const h = filled({ sol: pass(5, { verdict: 'PASS' }), swe: pass(5, { verdict: 'PASS' }) });
  const rep = bootstrapReport(h, CONFIG, 'FEATURE');
  assert.equal(rep.complete, true);
  assert.equal(rep.recommendation, 'PROMOTE_SWE2');
  assert.equal(rep.needsConfirmation, true);
});

test('a complete bootstrap keeps Sol first when SWE-2 passes less or flags more scope', () => {
  const worse = filled({ sol: pass(5), swe: [...pass(3), { verdict: 'REPAIR_REQUIRED', repairs: 1 }, { verdict: 'REPAIR_REQUIRED', repairs: 1 }] });
  assert.equal(bootstrapReport(worse, CONFIG, 'FEATURE').recommendation, 'KEEP_SOL');
  const flagged = filled({ sol: pass(5), swe: pass(5, { scopeFlags: 1 }) });
  assert.equal(bootstrapReport(flagged, CONFIG, 'FEATURE').recommendation, 'KEEP_SOL');
});

test('a bootstrap ended early without data for both candidates is INSUFFICIENT_DATA', () => {
  const h = endBootstrap(filled({ sol: pass(3), swe: [] }), 'FEATURE');
  const rep = bootstrapReport(h, CONFIG, 'FEATURE');
  assert.equal(rep.ended, true);
  assert.equal(rep.recommendation, 'INSUFFICIENT_DATA');
});

test('bootstrapReport reports classes outside the bootstrap as inactive', () => {
  const rep = bootstrapReport(emptyHistory(), CONFIG, 'SMALL_FIX');
  assert.equal(rep.active, false);
});

test('devinUsage totals runs and minutes per model for today and the last 7 days', () => {
  let h = emptyHistory();
  h = recordRun(h, rec({ runId: 'a', key: SWE, date: '2026-10-12', durationMin: 10 }));
  h = recordRun(h, rec({ runId: 'b', key: SWE, date: '2026-10-12', durationMin: 5 }));
  h = recordRun(h, rec({ runId: 'c', key: SOL, date: '2026-10-08', durationMin: 20 }));
  h = recordRun(h, rec({ runId: 'd', key: SOL, date: '2026-10-01', durationMin: 99 }));
  h = recordRun(h, rec({ runId: 'e', key: 'codex/gpt-6.1-sol@medium', date: '2026-10-12', durationMin: 7 }));
  const u = devinUsage(h, { now: NOW });
  assert.deepEqual(u.today, { 'devin/swe-2': { runs: 2, minutes: 15 } });
  assert.deepEqual(u.week, { 'devin/swe-2': { runs: 2, minutes: 15 }, 'devin/gpt-6-1-sol': { runs: 1, minutes: 20 } });
});

test('formatHistory lists keys sorted and says so when there are no runs', () => {
  assert.match(formatHistory(emptyHistory(), { config: CONFIG }), /No runs recorded/);
  const h = recordRun(emptyHistory(), rec({ runId: 'a' }));
  const text = formatHistory(h, { config: CONFIG });
  assert.match(text, /devin\/swe-2\/high\/FEATURE/);
  assert.match(text, /1 run/);
});

test('formatHistory --class filters and shows the bootstrap block for bootstrap classes', () => {
  let h = filled({ sol: pass(2), swe: pass(1) });
  h = recordRun(h, rec({ runId: 'z', class: 'SMALL_FIX', key: 'devin/swe-2@medium' }));
  const text = formatHistory(h, { config: CONFIG, klass: 'FEATURE' });
  assert.match(text, /FEATURE/);
  assert.doesNotMatch(text, /SMALL_FIX/);
  assert.match(text, /Bootstrap 3\/10/);
});

test('formatBootstrap warns that Reed must confirm before reordering', () => {
  const h = filled({ sol: pass(5), swe: pass(5) });
  const text = formatBootstrap(bootstrapReport(h, CONFIG, 'FEATURE'));
  assert.match(text, /PROMOTE_SWE2/);
  assert.match(text, /confirm/i);
});

test('saved history never contains absolute paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-h-'));
  const record = buildRunRecord({ status: status(), verdict: 'PASS', now: NOW });
  saveHistory(dir, recordRun(emptyHistory(), record));
  assert.doesNotMatch(readFileSync(join(dir, 'history.json'), 'utf8'), /[A-Za-z]:\\\\|\/Users\//);
});

test('bootstrapState feeds the router with counts since the reset, ended and promoted', () => {
  let h = emptyHistory();
  h = recordRun(h, rec({ runId: 'old', key: SOL, at: '2026-10-10T10:00:00.000Z' }));
  h = recordRun(h, rec({ runId: 'n1', key: SWE, at: '2026-10-12T10:00:00.000Z' }));
  h = recordRun(h, rec({ runId: 'n2', key: SWE, status: 'QUOTA_EXHAUSTED', verdict: 'FAILED', at: '2026-10-12T10:00:00.000Z' }));
  h = resetBootstrap(h, 'FEATURE', new Date('2026-10-11T00:00:00Z'));
  h = endBootstrap(h, 'FEATURE', { promote: SWE });
  const st = bootstrapState(h, CONFIG);
  assert.deepEqual(st.counts.FEATURE, { [SWE]: 1 });
  assert.deepEqual(st.counts.REFACTOR, {});
  assert.equal(st.ended.FEATURE, true);
  assert.equal(st.promoted.FEATURE, SWE);
});

test('an audited run that ended in PERMISSION_FAILURE keeps its verdict and is marked blocked', () => {
  const r = buildRunRecord({ status: status({ cls: 'PERMISSION_FAILURE' }), verdict: 'PASS', now: NOW });
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.permissionRetry, true);
  const repair = buildRunRecord({ status: status({ cls: 'PERMISSION_FAILURE' }), verdict: 'REPAIR_REQUIRED', repairs: 1, now: NOW });
  assert.equal(repair.verdict, 'REPAIR_REQUIRED');
});

test('PERMISSION_FAILURE without a verdict is still FAILED and not marked blocked', () => {
  const r = buildRunRecord({ status: status({ cls: 'PERMISSION_FAILURE' }), now: NOW });
  assert.equal(r.verdict, 'FAILED');
  assert.equal(r.permissionRetry, false);
});

test('other failures still reject an audited verdict', () => {
  assert.throws(() => buildRunRecord({ status: status({ cls: 'QUOTA_EXHAUSTED' }), verdict: 'PASS', now: NOW }), /verdict/i);
  assert.throws(() => buildRunRecord({ status: status({ cls: 'EXECUTION_FAILURE' }), verdict: 'REPAIR_REQUIRED', now: NOW }), /verdict/i);
});

test('an audited PERMISSION_FAILURE PASS counts as a success and does not penalize the model', () => {
  const agg = aggregateRuns([rec({ status: 'PERMISSION_FAILURE', verdict: 'PASS', permissionRetry: true }), rec()])['devin/swe-2/high/FEATURE'];
  assert.equal(agg.runs, 2);
  assert.equal(agg.success, 2);
  assert.equal(agg.problemRuns, 0);
  assert.equal(agg.permissionRetries, 1);
});

test('bootstrap counts an audited PERMISSION_FAILURE but not an unaudited one', () => {
  let h = emptyHistory();
  h = recordRun(h, rec({ runId: 'a', key: SWE, status: 'PERMISSION_FAILURE', verdict: 'PASS', permissionRetry: true }));
  h = recordRun(h, rec({ runId: 'b', key: SWE, status: 'PERMISSION_FAILURE', verdict: 'FAILED' }));
  const rep = bootstrapReport(h, CONFIG, 'FEATURE');
  assert.equal(rep.perKey[SWE].runs, 1);
  assert.equal(rep.perKey[SWE].passNoRepair, 1);
  assert.deepEqual(bootstrapState(h, CONFIG).counts.FEATURE, { [SWE]: 1 });
});
