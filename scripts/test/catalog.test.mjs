import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDevinModels,
  parseCodexModels,
  parseAgyModels,
  buildCatalog,
  refreshCatalog,
  setEnabled,
  slugFor,
  POOL,
} from '../lib/catalog.mjs';

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const devinJson = JSON.parse(readFileSync(join(fx, 'devin-models.json'), 'utf8'));
const codexJson = JSON.parse(readFileSync(join(fx, 'codex-models.json'), 'utf8'));
const agyText = readFileSync(join(fx, 'agy-models.txt'), 'utf8');

const byId = (list, id) => list.find((m) => m.id === id);

test('parseDevinModels extracts families with normalized efforts and no priority/fast variants', () => {
  const models = parseDevinModels(devinJson);
  const sol = byId(models, 'devin/gpt-6-1-sol');
  assert.deepEqual(sol.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(sol.slugTemplate, 'gpt-6-1-sol-{effort}');
  assert.equal(sol.harness, 'devin');
  assert.equal(sol.costTier, '$2/$10');

  assert.deepEqual(byId(models, 'devin/swe-2').efforts, ['medium', 'high', 'max']);
  assert.equal(byId(models, 'devin/swe-2').costTier, 'free');
  assert.deepEqual(byId(models, 'devin/deepseek-v4-1-flash').efforts, ['high', 'max']);
  assert.equal(byId(models, 'devin/claude-haiku-5-5').costTier, '$0.1/$0.5');
  assert.ok(byId(models, 'devin/claude-opus-5-5'));
});

test('parseCodexModels reads efforts, default effort and visibility', () => {
  const models = parseCodexModels(codexJson);
  const sol = byId(models, 'codex/gpt-6.1-sol');
  assert.deepEqual(sol.efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(sol.defaultEffort, 'low');
  assert.equal(sol.visible, true);
  assert.equal(sol.slugTemplate, 'gpt-6.1-sol');
  assert.equal(byId(models, 'codex/gpt-reserve').visible, false);
});

test('parseAgyModels groups effort-suffixed slugs under the base model', () => {
  const models = parseAgyModels(agyText);
  const flash = byId(models, 'agy/gemini-3.8-flash');
  assert.deepEqual(flash.efforts, ['low', 'medium', 'high']);
  assert.equal(flash.slugTemplate, 'gemini-3.8-flash');
  assert.deepEqual(byId(models, 'agy/claude-sonnet-4-6').efforts, []);
});

function discoveredAll() {
  return [...parseDevinModels(devinJson), ...parseCodexModels(codexJson), ...parseAgyModels(agyText)];
}

test('buildCatalog enables exactly the allowed pool and disables everything else', () => {
  const cat = buildCatalog({ discovered: discoveredAll(), previous: null });
  const enabled = cat.models.filter((m) => m.enabled).map((m) => m.id).sort();
  assert.deepEqual(enabled, POOL.map((p) => p.id).sort());
  assert.equal(byId(cat.models, 'devin/swe-2').allowedEfforts.join(), 'medium,high,max');
  assert.equal(byId(cat.models, 'codex/gpt-6.1-sol').allowedEfforts.includes('ultra'), false);
  assert.equal(byId(cat.models, 'agy/gemini-3.8-flash').allowedEfforts.join(), 'low,medium,high');
  assert.equal(byId(cat.models, 'devin/claude-opus-5-5').enabled, false);
  assert.equal(byId(cat.models, 'devin/gpt-6-luna').enabled, false);
  assert.equal(byId(cat.models, 'devin/gpt-6-1-sol').defaultEffort, 'medium');
});

test('first build marks nothing as new', () => {
  const cat = buildCatalog({ discovered: discoveredAll(), previous: null });
  assert.equal(cat.models.some((m) => m.new), false);
});

test('a model absent from the previous catalog appears as new and disabled', () => {
  const first = buildCatalog({ discovered: discoveredAll(), previous: null });
  const previous = { ...first, models: first.models.filter((m) => m.id !== 'devin/kimi-k3') };
  assert.ok(byId(first.models, 'devin/kimi-k3'), 'fixture should contain kimi-k3');
  const next = buildCatalog({ discovered: discoveredAll(), previous });
  const kimi = byId(next.models, 'devin/kimi-k3');
  assert.equal(kimi.new, true);
  assert.equal(kimi.enabled, false);
});

test('user disable survives a refresh', () => {
  const first = buildCatalog({ discovered: discoveredAll(), previous: null });
  const edited = setEnabled(first, 'devin/claude-haiku-5-5', false);
  const next = buildCatalog({ discovered: discoveredAll(), previous: edited });
  assert.equal(byId(next.models, 'devin/claude-haiku-5-5').enabled, false);
});

test('pool entries the CLI no longer lists are reported as missing', () => {
  const discovered = discoveredAll().filter((m) => m.id !== 'devin/swe-2');
  const cat = buildCatalog({ discovered, previous: null });
  assert.deepEqual(cat.missing, ['devin/swe-2']);
});

test('allowed efforts never include an effort the CLI does not list', () => {
  const discovered = discoveredAll().map((m) => (m.id === 'devin/deepseek-v4-1-flash' ? { ...m, efforts: ['high'] } : m));
  const cat = buildCatalog({ discovered, previous: null });
  assert.deepEqual(byId(cat.models, 'devin/deepseek-v4-1-flash').allowedEfforts, ['high']);
});

test('setEnabled validates efforts and rejects ultra', () => {
  const cat = buildCatalog({ discovered: discoveredAll(), previous: null });
  assert.throws(() => setEnabled(cat, 'codex/gpt-6.1-sol', true, ['ultra']), /ultra/);
  assert.throws(() => setEnabled(cat, 'devin/swe-2', true, ['low']), /effort/);
  assert.throws(() => setEnabled(cat, 'devin/nope', true), /unknown/i);
  const ok = setEnabled(cat, 'devin/gpt-6-luna', true, ['low', 'medium']);
  const luna = byId(ok.models, 'devin/gpt-6-luna');
  assert.equal(luna.enabled, true);
  assert.deepEqual(luna.allowedEfforts, ['low', 'medium']);
});

test('slugFor builds the right argument per harness', () => {
  const cat = buildCatalog({ discovered: discoveredAll(), previous: null });
  assert.equal(slugFor(byId(cat.models, 'devin/gpt-6-1-sol'), 'medium'), 'gpt-6-1-sol-medium');
  assert.equal(slugFor(byId(cat.models, 'devin/swe-2'), 'high'), 'swe-2-high');
  assert.equal(slugFor(byId(cat.models, 'codex/gpt-6.1-sol'), 'high'), 'gpt-6.1-sol');
  assert.equal(slugFor(byId(cat.models, 'agy/gemini-3.8-flash'), 'high'), 'gemini-3.8-flash');
  assert.throws(() => slugFor(byId(cat.models, 'devin/swe-2'), 'low'), /effort/);
});

test('refreshCatalog runs the CLIs through the injected runner and writes catalog.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cat-'));
  const calls = [];
  const run = async (exe, args) => {
    calls.push(`${exe} ${args.join(' ')}`);
    if (exe === 'DEVIN') return { status: 0, stdout: JSON.stringify(devinJson), stderr: '' };
    if (exe === 'CODEX') return { status: 0, stdout: JSON.stringify(codexJson), stderr: '' };
    if (exe === 'AGY') return { status: 0, stdout: agyText, stderr: '' };
    return { status: 1, stdout: '', stderr: 'boom' };
  };
  const cat = await refreshCatalog({ run, stateDir: dir, paths: { devin: 'DEVIN', codex: 'CODEX', agy: 'AGY' } });
  assert.ok(existsSync(join(dir, 'catalog.json')));
  assert.deepEqual(calls.sort(), ['AGY models', 'CODEX debug models', 'DEVIN models list --format json']);
  assert.equal(cat.models.filter((m) => m.enabled).length, POOL.length);
});

test('refreshCatalog survives one CLI failing and keeps its previous entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cat-'));
  const ok = async (exe) => {
    if (exe === 'DEVIN') return { status: 0, stdout: JSON.stringify(devinJson), stderr: '' };
    if (exe === 'CODEX') return { status: 0, stdout: JSON.stringify(codexJson), stderr: '' };
    return { status: 0, stdout: agyText, stderr: '' };
  };
  const paths = { devin: 'DEVIN', codex: 'CODEX', agy: 'AGY' };
  await refreshCatalog({ run: ok, stateDir: dir, paths });
  const broken = async (exe, args) => (exe === 'CODEX' ? { status: 1, stdout: '', stderr: 'down' } : ok(exe, args));
  const cat = await refreshCatalog({ run: broken, stateDir: dir, paths });
  assert.ok(byId(cat.models, 'codex/gpt-6.1-sol'));
  assert.ok(cat.errors.some((e) => e.harness === 'codex'));
});

test('refreshCatalog retries a CLI that timed out once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cat-'));
  const seen = { AGY: 0 };
  const run = async (exe) => {
    if (exe === 'DEVIN') return { status: 0, stdout: JSON.stringify(devinJson), stderr: '' };
    if (exe === 'CODEX') return { status: 0, stdout: JSON.stringify(codexJson), stderr: '' };
    seen.AGY++;
    if (seen.AGY === 1) return { status: -1, stdout: '', stderr: '', timedOut: true };
    return { status: 0, stdout: agyText, stderr: '' };
  };
  const cat = await refreshCatalog({ run, stateDir: dir, paths: { devin: 'DEVIN', codex: 'CODEX', agy: 'AGY' } });
  assert.equal(seen.AGY, 2);
  assert.deepEqual(cat.errors, []);
});
