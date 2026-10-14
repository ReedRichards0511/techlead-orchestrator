import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectReport, modelMatches, validateArchitectSettings } from '../lib/architect.mjs';
import { deepMerge } from '../lib/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const orch = join(root, 'scripts', 'orch.mjs');
const defaults = JSON.parse(readFileSync(join(root, 'config.defaults.json'), 'utf8'));

function run(args, state) {
  return spawnSync(process.execPath, [orch, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ORCH_STATE_DIR: state },
    timeout: 30000,
  });
}

test('defaults: Opus medium architect, inherited auditor, Haiku Figma reader', () => {
  assert.equal(defaults.architect.model, 'opus');
  assert.equal(defaults.architect.effort, 'medium');
  assert.equal(defaults.architect.enforce, false);
  assert.equal(defaults.subagents.auditor.model, 'inherit');
  assert.equal(defaults.subagents.figmaReader.model, 'haiku');
});

test('defaults: aggressive light mode covers the cheap classes', () => {
  const l = defaults.lightMode;
  assert.equal(l.enabled, true);
  assert.deepEqual(l.classes, ['SMALL_FIX', 'BUG_SIMPLE', 'TEST_GENERATION', 'MECHANICAL_CHANGE']);
  assert.equal(l.maxFiles, 5);
  assert.equal(l.maxChangedLines, 200);
});

test('modelMatches accepts aliases and full ids, case-insensitively', () => {
  assert.equal(modelMatches('opus', 'claude-opus-5-5'), true);
  assert.equal(modelMatches('opus', 'Claude Opus 5.5'), true);
  assert.equal(modelMatches('sonnet', 'claude-opus-5-5'), false);
  assert.equal(modelMatches('claude-opus-5-5', 'claude-opus-5-5'), true);
  assert.equal(modelMatches('opus', 'claude-opus-5-5[1m]'), true);
  assert.equal(modelMatches('opus', null), null);
});

test('report is OK when session matches the configured architect', () => {
  const r = architectReport(defaults, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.fix, []);
});

test('report lists the exact commands to fix a mismatch', () => {
  const r = architectReport(defaults, { model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(r.status, 'MISMATCH');
  assert.deepEqual(r.fix, ['/effort medium']);
  const s = architectReport(defaults, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(s.fix, ['/model opus']);
});

test('report is UNKNOWN without session data and never blocks', () => {
  const r = architectReport(defaults, {});
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.blocking, false);
});

test('enforce makes a mismatch blocking', () => {
  const cfg = deepMerge(defaults, { architect: { enforce: true } });
  assert.equal(architectReport(cfg, { model: 'claude-sonnet-5-5', effort: 'medium' }).blocking, true);
  assert.equal(architectReport(cfg, { model: 'claude-opus-5-5', effort: 'medium' }).blocking, false);
});

test('an unresolved ${CLAUDE_EFFORT} placeholder counts as unknown effort', () => {
  const r = architectReport(defaults, { model: 'claude-opus-5-5', effort: '${CLAUDE_EFFORT}' });
  assert.equal(r.status, 'OK');
});

test('report exposes auditor, figma reader and light mode for the skill', () => {
  const r = architectReport(defaults, {});
  assert.equal(r.auditor.model, 'inherit');
  assert.equal(r.figmaReader.model, 'haiku');
  assert.equal(r.lightMode.maxFiles, 5);
});

test('validateArchitectSettings rejects unknown models and efforts', () => {
  assert.equal(validateArchitectSettings({ model: 'opus', effort: 'medium' }), null);
  assert.match(validateArchitectSettings({ model: 'gpt' }), /model/);
  assert.match(validateArchitectSettings({ effort: 'ultra' }), /effort/);
  assert.match(validateArchitectSettings({ auditor: 'banana' }), /auditor/);
  assert.equal(validateArchitectSettings({ auditor: 'inherit' }), null);
  assert.equal(validateArchitectSettings({ model: 'claude-opus-5-5' }), null);
});

test('cli: orch architect --json reads the user config', () => {
  const state = mkdtempSync(join(tmpdir(), 'orch-architect-'));
  const r = run(['architect', '--session-model', 'claude-opus-5-5', '--session-effort', 'high', '--json'], state);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.architect.model, 'opus');
  assert.equal(out.status, 'MISMATCH');
  assert.deepEqual(out.fix, ['/effort medium']);
});

test('cli: orch architect set writes only the user config and validates', () => {
  const state = mkdtempSync(join(tmpdir(), 'orch-architect-'));
  const bad = run(['architect', 'set', '--model', 'banana'], state);
  assert.equal(bad.status, 2);
  const ok = run(['architect', 'set', '--model', 'sonnet', '--effort', 'high', '--auditor', 'sonnet', '--enforce', 'true'], state);
  assert.equal(ok.status, 0, ok.stderr);
  const user = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
  assert.equal(user.architect.model, 'sonnet');
  assert.equal(user.architect.effort, 'high');
  assert.equal(user.architect.enforce, true);
  assert.equal(user.subagents.auditor.model, 'sonnet');
  const r = run(['architect', '--json'], state);
  assert.equal(JSON.parse(r.stdout).architect.model, 'sonnet');
});

test('cli: set preserves other user keys', () => {
  const state = mkdtempSync(join(tmpdir(), 'orch-architect-'));
  writeFileSync(join(state, 'config.json'), JSON.stringify({ repairMaxCycles: 1 }));
  assert.equal(run(['architect', 'set', '--effort', 'low'], state).status, 0);
  const user = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
  assert.equal(user.repairMaxCycles, 1);
  assert.equal(user.architect.effort, 'low');
});
