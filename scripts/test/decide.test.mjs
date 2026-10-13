import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeDecision } from '../lib/decide.mjs';
import { buildCatalog, parseDevinModels, parseCodexModels, parseAgyModels } from '../lib/catalog.mjs';
import { markExhausted } from '../lib/quota/index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = f => readFileSync(join(here, 'fixtures', f), 'utf8');
function state() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-choice-'));
  const catalog = buildCatalog({ discovered: [
    ...parseDevinModels(JSON.parse(fx('devin-models.json'))),
    ...parseCodexModels(JSON.parse(fx('codex-models.json'))),
    ...parseAgyModels(fx('agy-models.txt')),
  ], previous: null });
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ platformOverrides: { paths: { devin: process.execPath, codex: process.execPath, agy: process.execPath } } }));
  return dir;
}

test('computing recommendations never fetches quotas or writes a quota cache', async () => {
  const dir = state();
  const { decision } = await computeDecision({ klass: 'FEATURE', stateDir: dir });
  assert.equal(decision.options.length, 4);
  assert.equal(existsSync(join(dir, 'quota-cache.json')), false);
  const payload = { codex: { source: 'official', health: 'EXHAUSTED' }, devin: { source: 'manual', health: 'EXHAUSTED' } };
  const before = JSON.stringify(payload);
  writeFileSync(join(dir, 'quota-cache.json'), before);
  assert.deepEqual((await computeDecision({ klass: 'FEATURE', stateDir: dir })).decision.options, decision.options);
  assert.equal(readFileSync(join(dir, 'quota-cache.json'), 'utf8'), before);
});

test('reported quota errors affect recommendations until their reactive marker expires', async () => {
  const dir = state();
  markExhausted({ stateDir: dir, provider: 'devin' });
  let { decision } = await computeDecision({ klass: 'FEATURE', stateDir: dir });
  assert.equal(decision.recommended.harness, 'codex');
  markExhausted({ stateDir: dir, provider: 'devin', now: new Date(Date.now() - 61 * 60000) });
  decision = (await computeDecision({ klass: 'FEATURE', stateDir: dir })).decision;
  assert.equal(decision.recommended.harness, 'devin');
  writeFileSync(join(dir, 'quota-cache.json'), '{broken');
  assert.equal((await computeDecision({ klass: 'FEATURE', stateDir: dir })).decision.options.length, 4);
});

test('the CLI returns an AskUserQuestion payload without taking a lock or starting a worker', () => {
  const dir = state();
  const r = spawnSync(process.execPath, [join(here, '..', 'orch.mjs'), 'route', '--class', 'FEATURE', '--json'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, ORCH_STATE_DIR: dir }, timeout: 10000,
  });
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.requiresSelection, true);
  assert.equal(d.question.questions[0].options.length, 4);
  assert.ok(d.question.questions[0].options[0].label.includes(d.recommended.displayName));
  assert.equal(existsSync(join(dir, '.orchestrator')), false);
  assert.equal(existsSync(join(dir, 'quota-cache.json')), false);
});
