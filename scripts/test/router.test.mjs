import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as routing from '../lib/router.mjs';
import { buildCatalog, parseDevinModels, parseCodexModels, parseAgyModels, setEnabled, POOL } from '../lib/catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = f => readFileSync(join(here, 'fixtures', f), 'utf8');
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const catalog = buildCatalog({ discovered: [
  ...parseDevinModels(JSON.parse(fx('devin-models.json'))),
  ...parseCodexModels(JSON.parse(fx('codex-models.json'))),
  ...parseAgyModels(fx('agy-models.txt')),
], previous: null });
const base = (over = {}) => ({ klass: 'CROSS_LAYER_FEATURE', catalog, config, quotas: {}, ...over });
const key = c => `${c.id}@${c.effort}`;
const recommend = over => routing.route(base(over));

test('unknown classes are rejected and known classes retain their estimated durations', () => {
  assert.throws(() => recommend({ klass: 'NOPE' }), /class/i);
  assert.equal(routing.CLASSES.SMALL_FIX.estimatedMinutes, 15);
  assert.equal(routing.CLASSES.ARCHITECTURAL_IMPL.estimatedMinutes, 90);
});

test('every class offers one recommendation and three distinct approved alternatives', () => {
  const approved = new Set(POOL.map(p => p.id));
  for (const klass of Object.keys(routing.CLASSES)) {
    const d = recommend({ klass });
    assert.equal(d.requiresSelection, true);
    assert.equal(d.options.length, 4, klass);
    assert.equal(new Set(d.options.map(c => c.id)).size, 4);
    assert.deepEqual(d.recommended, d.options[0]);
    assert.equal(d.planContradictionFallback, 'NONE');
    for (const c of d.options) {
      assert.ok(approved.has(c.id));
      assert.ok(catalog.models.find(m => m.id === c.id).allowedEfforts.includes(c.effort));
      assert.ok(c.reason.length > 0);
    }
  }
});

test('recommendations use task-specific model and effort without choosing a worker to execute', () => {
  assert.equal(key(recommend().recommended), 'devin/gpt-6-1-sol@medium');
  assert.equal(key(recommend({ klass: 'SMALL_FIX' }).recommended), 'devin/swe-2@medium');
  assert.equal(key(recommend({ klass: 'MECHANICAL_CHANGE' }).recommended), 'devin/swe-2@high');
  assert.equal(key(recommend({ klass: 'NATIVE_MOBILE' }).recommended), 'devin/gpt-6-1-sol@high');
  assert.equal(recommend().selected, undefined);
});

test('quota percentages, reserves and legacy bootstrap counts cannot change recommendations', () => {
  const normal = recommend({ klass: 'FEATURE' });
  const legacy = recommend({ klass: 'FEATURE',
    quotas: { devin: { health: 'EXHAUSTED' }, codex: { health: 'PROTECTED' } },
    bootstrap: { counts: { FEATURE: { 'devin/gpt-6-1-sol@medium': 9, 'devin/swe-2@high': 0 } }, ended: {} },
  });
  assert.deepEqual(legacy.options, normal.options);
  assert.doesNotMatch(legacy.reason, /Bootstrap|quota|reserve/i);
});

test('only providers with a reported execution-time limit are excluded', () => {
  const d = recommend({ klass: 'NATIVE_MOBILE', exhaustedProviders: ['devin'] });
  assert.equal(key(d.recommended), 'codex/gpt-6.1-sol@high');
  assert.ok(d.options.every(c => c.harness !== 'devin'));
  assert.ok(d.excluded.some(c => c.id === 'devin/gpt-6-1-sol' && /reported.*limit/i.test(c.reason)));
});

test('disabled models, invalid efforts and unavailable CLIs cannot be offered', () => {
  const cat = setEnabled(setEnabled(catalog, 'devin/gpt-6-1-sol', true, ['low']), 'devin/claude-sonnet-5-5', false);
  const d = recommend({ catalog: cat, workers: { devin: true, codex: false, agy: false } });
  assert.ok(d.excluded.some(c => /effort/i.test(c.reason)));
  assert.ok(d.excluded.some(c => /disabled/i.test(c.reason)));
  assert.ok(d.excluded.some(c => /CLI unavailable/i.test(c.reason)));
  assert.equal(d.options.length, 1);
  assert.equal(d.options[0].id, 'devin/swe-2');
});

test('fewer available candidates produce fewer options rather than invented models', () => {
  const d = recommend({ workers: { devin: false, codex: true, agy: false } });
  assert.equal(d.options.length, 1);
  assert.equal(d.recommended.id, 'codex/gpt-6.1-sol');
  const none = recommend({ workers: { devin: false, codex: false, agy: false } });
  assert.equal(none.recommended, null);
  assert.deepEqual(none.options, []);
  assert.ok(none.excluded.length >= 4);
  assert.equal(routing.workerQuestion(none), null);
});

test('excluding a failed tuple offers alternatives for another user choice', () => {
  const first = recommend();
  const next = recommend({ exclude: [key(first.recommended)] });
  assert.deepEqual(next.recommended, first.options[1]);
  assert.equal(next.requiresSelection, true);
});

test('the interactive question exposes exactly the available tuples with a single selection', () => {
  const d = recommend({ klass: 'FEATURE' });
  const payload = routing.workerQuestion(d);
  assert.equal(payload.questions.length, 1);
  const q = payload.questions[0];
  assert.equal(q.multiSelect, false);
  assert.ok(q.header.length <= 12);
  assert.equal(q.options.length, 4);
  assert.match(q.options[0].label, /Recomendado/);
  assert.ok(q.options[0].description.includes(d.reason));
  assert.equal(new Set(q.options.map(o => o.label)).size, 4);
  for (const [i, option] of q.options.entries()) {
    assert.ok(option.label.includes(d.options[i].displayName));
    assert.ok(option.description.length > 0);
  }
});

test('a single candidate still requires a decision and can be declined', () => {
  const d = recommend({ workers: { devin: false, codex: true, agy: false } });
  const q = routing.workerQuestion(d).questions[0];
  assert.equal(q.options.length, 2);
  assert.match(q.options[1].label, /No ejecutar/);
  assert.equal(d.requiresSelection, true);
});

test('history changes recommendation order only with enough evidence within the same tier', () => {
  const history = {
    'devin/deepseek-v4-1-flash/high/SMALL_FIX': { runs: 6, problemRuns: 3 },
    'devin/claude-haiku-5-5/medium/SMALL_FIX': { runs: 4, problemRuns: 0 },
  };
  const d = recommend({ klass: 'SMALL_FIX', history });
  assert.ok(d.options.findIndex(c => c.id === 'devin/claude-haiku-5-5') < d.options.findIndex(c => c.id === 'devin/deepseek-v4-1-flash'));
  assert.ok(d.notes.some(n => /demoted by history/.test(n)));
  history['devin/deepseek-v4-1-flash/high/SMALL_FIX'].runs = 4;
  assert.equal(recommend({ klass: 'SMALL_FIX', history }).options[1].id, 'devin/deepseek-v4-1-flash');
});

test('an explicitly promoted candidate can lead its tier but remains subject to user choice', () => {
  const bootstrap = { promoted: { FEATURE: 'devin/swe-2@high' } };
  assert.equal(key(recommend({ klass: 'FEATURE', bootstrap }).recommended), 'devin/swe-2@high');
  bootstrap.promoted.FEATURE = 'codex/gpt-6.1-sol@medium';
  assert.equal(key(recommend({ klass: 'FEATURE', bootstrap }).recommended), 'devin/gpt-6-1-sol@medium');
});

test('the text recommendation shows alternatives and waits for selection without quota noise', () => {
  const text = routing.formatDecision(recommend(), { history: { 'devin/gpt-6-1-sol/medium/CROSS_LAYER_FEATURE': { runs: 6, repairRequired: 1 } } });
  assert.match(text, /Recommended:.*Devin \/ GPT-6.1 Sol \/ Medium/);
  assert.match(text, /Alternatives:/);
  assert.match(text, /6 runs in this class/);
  assert.match(text, /Awaiting user selection/);
  assert.doesNotMatch(text, /Quota:|remaining|reserve|auto.*fallback/i);
  assert.match(routing.formatDecision(recommend({ workers: { devin: false, codex: false, agy: false } })), /No eligible candidate/);
});

test('bootstrap accounting ignores external failures and includes audited permission failures', () => {
  const runs = [
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'SUCCESS' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'QUOTA_EXHAUSTED' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'PERMISSION_FAILURE', verdict: 'PASS' },
    { class: 'FEATURE', key: 'devin/swe-2@high', status: 'PERMISSION_FAILURE', verdict: 'FAILED' },
  ];
  assert.deepEqual(routing.countBootstrapRuns(runs, 'FEATURE'), { 'devin/swe-2@high': 2 });
});
