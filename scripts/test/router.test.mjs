import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, formatDecision, countBootstrapRuns, CLASSES } from '../lib/router.mjs';
import { buildCatalog, parseDevinModels, parseCodexModels, parseAgyModels, setEnabled } from '../lib/catalog.mjs';
import { buildQuota, unknownQuota, windowFromUsed, windowFromRemaining } from '../lib/quota/normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, 'fixtures', f), 'utf8');
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const now = new Date('2026-10-12T12:00:00Z');
const inSec = (s) => Math.floor(now.getTime() / 1000) + s;

const discovered = [
  ...parseDevinModels(JSON.parse(fx('devin-models.json'))),
  ...parseCodexModels(JSON.parse(fx('codex-models.json'))),
  ...parseAgyModels(fx('agy-models.txt')),
];
const catalog = buildCatalog({ discovered, previous: null, now });

function q(provider, { short, daily, weekly, shortReset = 3600, weeklyReset = 86400, source = 'official' }) {
  const windows = {};
  if (short !== undefined) windows.short = windowFromRemaining(short, inSec(shortReset), now);
  if (daily !== undefined) windows.daily = windowFromRemaining(daily, inSec(shortReset), now);
  if (weekly !== undefined) windows.weekly = windowFromRemaining(weekly, inSec(weeklyReset), now);
  return buildQuota({ provider, source, retrievedAt: now, windows, config, now });
}

const healthy = () => ({
  devin: q('devin', { daily: 96, weekly: 91, source: 'unofficial' }),
  codex: q('codex', { short: 95, weekly: 90 }),
  antigravity: unknownQuota('antigravity'),
  claude: unknownQuota('claude'),
});

const noBootstrap = { counts: {}, ended: {} };
const base = (over = {}) => ({ klass: 'CROSS_LAYER_FEATURE', catalog, quotas: healthy(), config, bootstrap: noBootstrap, history: {}, ...over });
const sel = (d) => `${d.selected.id}@${d.selected.effort}`;

test('every class has an estimated duration from the plan', () => {
  assert.equal(CLASSES.SMALL_FIX.estimatedMinutes, 15);
  assert.equal(CLASSES.ARCHITECTURAL_IMPL.estimatedMinutes, 90);
  assert.equal(Object.keys(CLASSES).length, 11);
});

test('unknown class throws', () => {
  assert.throws(() => route(base({ klass: 'NOPE' })), /class/i);
});

test('cross-layer feature picks Devin Sol Medium with Sonnet High as fallback', () => {
  const d = route(base());
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
  assert.equal(`${d.fallback.id}@${d.fallback.effort}`, 'devin/claude-sonnet-5-5@high');
  assert.equal(d.planContradictionFallback, 'NONE');
});

test('Devin 96/91 beats Codex 95/28 for native mobile', () => {
  const quotas = { ...healthy(), codex: q('codex', { short: 95, weekly: 28, weeklyReset: 4 * 86400 }) };
  const d = route(base({ klass: 'NATIVE_MOBILE', quotas }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@high');
  assert.equal(`${d.fallback.id}@${d.fallback.effort}`, 'codex/gpt-6.1-sol@high');
});

test('a weaker candidate with plenty of quota does not win', () => {
  const quotas = { ...healthy(), devin: q('devin', { daily: 22, weekly: 24, source: 'unofficial' }), codex: q('codex', { short: 100, weekly: 100 }) };
  const d = route(base({ klass: 'SMALL_FIX', quotas }));
  assert.equal(sel(d), 'devin/swe-2@medium');
});

test('PROTECTED drops a provider to the end of its tier unless authorized', () => {
  const quotas = { ...healthy(), antigravity: q('antigravity', { weekly: 5, source: 'official' }) };
  const noDevin = { devin: false, codex: true, agy: true };
  const d = route(base({ klass: 'SMALL_FIX', quotas, workers: noDevin }));
  assert.equal(sel(d), 'codex/gpt-6-luna@high');
  const allowed = route(base({ klass: 'SMALL_FIX', quotas, workers: noDevin, allowProtected: ['antigravity'] }));
  assert.equal(sel(allowed), 'agy/gemini-3.8-flash@high');
});

test('a PROTECTED provider with no alternative is still selected and flagged', () => {
  const quotas = { ...healthy(), devin: q('devin', { daily: 0, weekly: 0, source: 'unofficial' }), codex: q('codex', { short: 50, weekly: 15 }) };
  const d = route(base({ klass: 'NATIVE_MOBILE', quotas }));
  assert.equal(sel(d), 'codex/gpt-6.1-sol@high');
  assert.ok(d.notes.some((n) => /protected/i.test(n)));
});

test('UNKNOWN quota is neutral and flagged, never treated as 100%', () => {
  const d = route(base({ klass: 'SMALL_FIX', workers: { devin: false, codex: true, agy: true } }));
  assert.equal(sel(d), 'agy/gemini-3.8-flash@high');
  assert.deepEqual(d.quotaUnknown, ['antigravity']);
  assert.match(formatDecision(d, { config }), /quota unknown/);
});

test('CRITICAL with a far reset drops one tier', () => {
  const quotas = { ...healthy(), devin: q('devin', { daily: 5, weekly: 5, weeklyReset: 3 * 86400, shortReset: 3 * 86400, source: 'unofficial' }) };
  const d = route(base({ klass: 'NATIVE_MOBILE', quotas }));
  assert.equal(sel(d), 'codex/gpt-6.1-sol@high');
});

test('CRITICAL that resets before the task would end is not penalized', () => {
  const quotas = { ...healthy(), devin: q('devin', { daily: 5, weekly: 80, shortReset: 600, source: 'unofficial' }) };
  const d = route(base({ klass: 'NATIVE_MOBILE', quotas }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@high');
});

test('EXHAUSTED providers are excluded with a reason', () => {
  const quotas = { ...healthy(), devin: q('devin', { daily: 0, weekly: 0, source: 'unofficial' }) };
  const d = route(base({ klass: 'NATIVE_MOBILE', quotas }));
  assert.equal(sel(d), 'codex/gpt-6.1-sol@high');
  assert.ok(d.excluded.some((e) => e.id === 'devin/gpt-6-1-sol' && /exhausted/i.test(e.reason)));
});

test('disabled models, disallowed efforts and missing workers are filtered', () => {
  let cat = setEnabled(catalog, 'devin/gpt-6-1-sol', true, ['low']);
  let d = route(base({ catalog: cat }));
  assert.ok(d.excluded.some((e) => e.id === 'devin/gpt-6-1-sol' && /effort/i.test(e.reason)));
  assert.equal(sel(d), 'devin/claude-sonnet-5-5@high');

  cat = setEnabled(catalog, 'devin/claude-sonnet-5-5', false);
  d = route(base({ catalog: cat }));
  assert.ok(d.excluded.some((e) => e.id === 'devin/claude-sonnet-5-5' && /disabled/i.test(e.reason)));

  d = route(base({ workers: { devin: false, codex: true, agy: true } }));
  assert.equal(sel(d), 'codex/gpt-6.1-sol@medium');
});

test('no usable candidate yields selected=null with every exclusion explained', () => {
  const d = route(base({ workers: { devin: false, codex: false, agy: false } }));
  assert.equal(d.selected, null);
  assert.ok(d.excluded.length >= 3);
});

test('exclude recalculates the next candidate after a failure', () => {
  const first = route(base());
  const next = route(base({ exclude: [`${first.selected.id}@${first.selected.effort}`] }));
  assert.equal(sel(next), `${first.fallback.id}@${first.fallback.effort}`);
});

test('bootstrap alternates the candidate with fewer runs, Sol on ties', () => {
  const key = (n, m) => ({ counts: { FEATURE: { 'devin/gpt-6-1-sol@medium': n, 'devin/swe-2@high': m } }, ended: {} });
  let d = route(base({ klass: 'FEATURE', bootstrap: key(2, 2) }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
  assert.match(d.reason, /Bootstrap 4\/10 for FEATURE/);
  d = route(base({ klass: 'FEATURE', bootstrap: key(3, 2) }));
  assert.equal(sel(d), 'devin/swe-2@high');
  assert.equal(`${d.fallback.id}@${d.fallback.effort}`, 'devin/gpt-6-1-sol@medium');
});

test('bootstrap with no data starts on Sol', () => {
  const d = route(base({ klass: 'REFACTOR', bootstrap: noBootstrap }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
  assert.match(d.reason, /Bootstrap 0\/10 for REFACTOR/);
});

test('bootstrap stops after the configured number of runs or when ended', () => {
  const done = { counts: { FEATURE: { 'devin/gpt-6-1-sol@medium': 4, 'devin/swe-2@high': 6 } }, ended: {} };
  let d = route(base({ klass: 'FEATURE', bootstrap: done }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
  assert.doesNotMatch(d.reason, /Bootstrap/);
  const ended = { counts: { MIGRATION: { 'devin/gpt-6-1-sol@medium': 3, 'devin/swe-2@high': 0 } }, ended: { MIGRATION: true } };
  d = route(base({ klass: 'MIGRATION', bootstrap: ended }));
  assert.doesNotMatch(d.reason, /Bootstrap/);
});

test('bootstrap does not apply to other classes or when disabled', () => {
  const counts = { counts: { CROSS_LAYER_FEATURE: { 'devin/gpt-6-1-sol@medium': 5, 'devin/swe-2@high': 0 } }, ended: {} };
  assert.doesNotMatch(route(base({ bootstrap: counts })).reason, /Bootstrap/);
  const off = { ...config, bootstrap: { ...config.bootstrap, enabled: false } };
  assert.doesNotMatch(route(base({ klass: 'FEATURE', config: off })).reason, /Bootstrap/);
});

test('bootstrap with a single eligible candidate does not alternate', () => {
  const cat = setEnabled(catalog, 'devin/swe-2', false);
  const d = route(base({ klass: 'FEATURE', catalog: cat, bootstrap: { counts: { FEATURE: { 'devin/gpt-6-1-sol@medium': 5, 'devin/swe-2@high': 0 } }, ended: {} } }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
});

test('countBootstrapRuns ignores runs that failed for external reasons', () => {
  const runs = [
    { class: 'FEATURE', key: 'devin/gpt-6-1-sol@medium', status: 'SUCCESS' },
    { class: 'FEATURE', key: 'devin/gpt-6-1-sol@medium', status: 'VALIDATION_FAILURE' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'QUOTA_EXHAUSTED' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'TIMEOUT' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'EXECUTION_FAILURE' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'PLAN_CONTRADICTION' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'RATE_LIMITED' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'SUCCESS' },
    { class: 'REFACTOR', key: 'devin/swe-2@high', status: 'SUCCESS' },
  ];
  const c = countBootstrapRuns(runs, 'FEATURE');
  assert.deepEqual(c, { 'devin/gpt-6-1-sol@medium': 2, 'devin/swe-2@high': 1 });
});

test('history demotes a candidate whose failure rate is 25+ points worse than the next in its tier', () => {
  const history = {
    'devin/deepseek-v4-1-flash/high/SMALL_FIX': { runs: 6, repairRequired: 2, validationFailures: 1 },
    'devin/claude-haiku-5-5/medium/SMALL_FIX': { runs: 4, repairRequired: 0, validationFailures: 0 },
  };
  const d = route(base({ klass: 'SMALL_FIX', history, workers: { devin: true, codex: true, agy: true } }));
  const order = d.ranked.map((c) => c.id);
  assert.ok(order.indexOf('devin/claude-haiku-5-5') < order.indexOf('devin/deepseek-v4-1-flash'));
  assert.ok(d.notes.some((n) => /deepseek/i.test(n) && /history/i.test(n)));
});

test('history needs at least 5 runs of the candidate to act', () => {
  const history = {
    'devin/deepseek-v4-1-flash/high/SMALL_FIX': { runs: 4, repairRequired: 4, validationFailures: 0 },
    'devin/claude-haiku-5-5/medium/SMALL_FIX': { runs: 4, repairRequired: 0, validationFailures: 0 },
  };
  const d = route(base({ klass: 'SMALL_FIX', history }));
  const order = d.ranked.map((c) => c.id);
  assert.ok(order.indexOf('devin/deepseek-v4-1-flash') < order.indexOf('devin/claude-haiku-5-5'));
});

test('formatDecision follows the plan layout', () => {
  const d = route(base());
  const text = formatDecision(d, { config, history: { 'devin/gpt-6-1-sol/medium/CROSS_LAYER_FEATURE': { runs: 6, repairRequired: 1 } } });
  const lines = text.split('\n');
  assert.equal(lines[0], 'ROUTING DECISION');
  assert.equal(lines[1], 'Task class: CROSS_LAYER_FEATURE');
  assert.equal(lines[2], 'Selected:   Devin / GPT-6.1 Sol / Medium');
  assert.match(text, /^Reason:\s+\S/m);
  assert.match(text, /^Quota:\s+Devin daily HEALTHY \(96%, reset 1h\)/m);
  assert.match(text, /\[source: unofficial\]/);
  assert.match(text, /^History:\s+6 runs in this class · 1 repair/m);
  assert.match(text, /^Fallback if execution failure: Devin \/ Claude Sonnet 5\.5 \/ High/m);
  assert.match(text, /^PLAN_CONTRADICTION fallback: NONE → back to Opus/m);
});

test('formatDecision for no candidate says so', () => {
  const d = route(base({ workers: { devin: false, codex: false, agy: false } }));
  assert.match(formatDecision(d, { config }), /No eligible candidate/);
});

test('history failure rate counts a run with repair and validation failure once (problemRuns)', () => {
  const history = {
    'devin/deepseek-v4-1-flash/high/SMALL_FIX': { runs: 6, repairRequired: 2, validationFailures: 2, problemRuns: 2 },
    'devin/claude-haiku-5-5/medium/SMALL_FIX': { runs: 4, repairRequired: 1, validationFailures: 0, problemRuns: 1 },
  };
  const d = route(base({ klass: 'SMALL_FIX', history, workers: { devin: true, codex: true, agy: true } }));
  const order = d.ranked.map((c) => c.id);
  assert.ok(order.indexOf('devin/deepseek-v4-1-flash') < order.indexOf('devin/claude-haiku-5-5'));
  assert.ok(!d.notes.some((n) => /history/i.test(n)));
});

test('a promoted bootstrap candidate goes first within its tier once the bootstrap ended', () => {
  const ended = { counts: {}, ended: { FEATURE: true }, promoted: { FEATURE: 'devin/swe-2@high' } };
  const d = route(base({ klass: 'FEATURE', bootstrap: ended }));
  assert.equal(sel(d), 'devin/swe-2@high');
  assert.equal(d.ranked[1].id, 'devin/gpt-6-1-sol');
  assert.ok(d.notes.some((n) => /promoted/i.test(n)));
  assert.match(d.reason, /promoted/i);
});

test('without a promotion Sol stays first after the bootstrap', () => {
  const ended = { counts: {}, ended: { FEATURE: true }, promoted: {} };
  assert.equal(sel(route(base({ klass: 'FEATURE', bootstrap: ended }))), 'devin/gpt-6-1-sol@medium');
});

test('a promoted candidate that is not eligible is ignored', () => {
  const cat = setEnabled(catalog, 'devin/swe-2', false);
  const ended = { counts: {}, ended: { FEATURE: true }, promoted: { FEATURE: 'devin/swe-2@high' } };
  const d = route(base({ klass: 'FEATURE', catalog: cat, bootstrap: ended }));
  assert.equal(sel(d), 'devin/gpt-6-1-sol@medium');
  assert.ok(!d.notes.some((n) => /promoted/i.test(n)));
});

test('a promoted candidate never jumps over a better tier', () => {
  const ended = { counts: {}, ended: { FEATURE: true }, promoted: { FEATURE: 'codex/gpt-6.1-sol@medium' } };
  assert.equal(sel(route(base({ klass: 'FEATURE', bootstrap: ended }))), 'devin/gpt-6-1-sol@medium');
});
