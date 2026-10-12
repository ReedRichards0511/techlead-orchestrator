import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindows } from '../lib/platform.mjs';

const orch = join(dirname(fileURLToPath(import.meta.url)), '..', 'orch.mjs');
const state = mkdtempSync(join(tmpdir(), 'orch-cli-'));

function orchRun(args, stateOverride) {
  return spawnSync(process.execPath, [orch, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ORCH_STATE_DIR: stateOverride ?? state },
    timeout: 90000,
  });
}

const real = { skip: !isWindows };

test('doctor --json reproduces the verified environment', real, () => {
  const r = orchRun(['doctor', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.ok, true);
  for (const n of ['claude', 'devin', 'codex', 'agy']) assert.equal(d.clis[n].found, true, n);
  assert.equal(d.clis.devin.auth, 'ok');
  assert.equal(d.clis.codex.auth, 'ok');
  assert.equal(r.stdout.includes('@'), false, 'doctor must not print emails');
});

test('doctor table prints versions', real, () => {
  const r = orchRun(['doctor']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /devin/);
  assert.match(r.stdout, /3000\.11\.3/);
  assert.match(r.stdout, /P1/);
});

test('models before refresh tells the user what to do', () => {
  const r = orchRun(['models']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /models refresh/);
});

test('models refresh writes the catalog with the pool enabled', real, () => {
  const r = orchRun(['models', 'refresh', '--json']);
  assert.equal(r.status, 0, r.stderr + ' ' + (r.stdout.match(/"errors"[sS]*$/) ?? [''])[0]);
  assert.ok(existsSync(join(state, 'catalog.json')));
  const cat = JSON.parse(r.stdout);
  const enabled = cat.models.filter((m) => m.enabled).map((m) => m.id);
  assert.equal(enabled.length, 8);
  assert.ok(enabled.includes('devin/gpt-6-1-sol'));
  assert.ok(enabled.includes('agy/gemini-3.8-flash'));
});

test('models table lists enabled entries', real, () => {
  const r = orchRun(['models']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /devin\/gpt-6-1-sol/);
  assert.match(r.stdout, /codex\/gpt-6\.1-sol/);
});

test('models disable then enable round-trips through catalog.json', real, () => {
  assert.equal(orchRun(['models', 'disable', 'devin/swe-2']).status, 0);
  let cat = JSON.parse(orchRun(['models', '--json']).stdout);
  assert.equal(cat.models.find((m) => m.id === 'devin/swe-2').enabled, false);
  assert.equal(orchRun(['models', 'enable', 'devin/swe-2', 'medium,high']).status, 0);
  cat = JSON.parse(orchRun(['models', '--json']).stdout);
  const swe = cat.models.find((m) => m.id === 'devin/swe-2');
  assert.equal(swe.enabled, true);
  assert.deepEqual(swe.allowedEfforts, ['medium', 'high']);
});

test('models enable with a forbidden effort fails', real, () => {
  const r = orchRun(['models', 'enable', 'codex/gpt-6.1-sol', 'ultra']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ultra/);
});

test('quota set stores a manual devin reading', () => {
  const r = orchRun(['quota', 'set', 'devin', 'daily=80', 'weekly=60']);
  assert.equal(r.status, 0, r.stderr);
  const q = JSON.parse(orchRun(['quota', '--json']).stdout);
  assert.equal(q.devin.source, 'manual');
  assert.equal(q.devin.windows.weekly.remainingPercent, 60);
});

test('quota set rejects malformed input', () => {
  assert.notEqual(orchRun(['quota', 'set', 'devin', 'daily=abc']).status, 0);
  assert.notEqual(orchRun(['quota', 'set', 'nobody', 'daily=10']).status, 0);
  assert.notEqual(orchRun(['quota', 'set', 'devin', 'daily=140']).status, 0);
});

test('quota refresh reads codex live without exposing identifiers', real, () => {
  const r = orchRun(['quota', 'refresh', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const q = JSON.parse(r.stdout);
  assert.equal(q.codex.source, 'official');
  assert.equal(q.codex.freshness, 'LIVE');
  assert.equal(q.claude.health, 'UNKNOWN');
  assert.equal(q.antigravity.health, 'UNKNOWN');
  assert.equal(/@|accountId|credits/i.test(r.stdout), false);
});

test('quota table shows every provider', real, () => {
  const r = orchRun(['quota']);
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['CLAUDE', 'DEVIN', 'CODEX', 'ANTIGRAVITY']) assert.match(r.stdout, new RegExp(n));
});

test('quota exhausted marks a provider reactively', () => {
  assert.equal(orchRun(['quota', 'exhausted', 'antigravity']).status, 0);
  const q = JSON.parse(orchRun(['quota', '--json']).stdout);
  assert.equal(q.antigravity.health, 'EXHAUSTED');
  assert.equal(q.antigravity.source, 'reactive');
});

test('route prints the decision block for a class', real, () => {
  const r = orchRun(['route', '--class', 'CROSS_LAYER_FEATURE']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(/\r?\n/)[0], 'ROUTING DECISION');
  assert.match(r.stdout, /Selected:\s+Devin \/ GPT-6\.1 Sol \/ Medium/);
  assert.match(r.stdout, /PLAN_CONTRADICTION fallback: NONE/);
});

test('route --json exposes selected, fallback and exclusions', real, () => {
  const r = orchRun(['route', '--class', 'SMALL_FIX', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const d = JSON.parse(r.stdout);
  assert.equal(d.selected.id, 'devin/swe-2');
  assert.ok(d.fallback);
  assert.ok(Array.isArray(d.excluded));
  assert.equal(/@/.test(r.stdout.replace(/@(low|medium|high|xhigh|max)/g, '')), false);
});

test('route --explain lists ranked candidates', real, () => {
  const r = orchRun(['route', '--class', 'NATIVE_MOBILE', '--explain']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Candidates/);
  assert.match(r.stdout, /codex\/gpt-6\.1-sol/);
});

test('route --exclude recalculates after a failure', real, () => {
  const r = orchRun(['route', '--class', 'CROSS_LAYER_FEATURE', '--exclude', 'devin/gpt-6-1-sol@medium', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).selected.id, 'devin/claude-sonnet-5-5');
});

test('route rejects an unknown class', () => {
  const r = orchRun(['route', '--class', 'NOPE']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /class/i);
});

test('route without --class explains usage', () => {
  assert.equal(orchRun(['route']).status, 2);
});

test('route without a catalog asks for models refresh', () => {
  const empty = mkdtempSync(join(tmpdir(), 'orch-empty-'));
  const r = orchRun(['route', '--class', 'SMALL_FIX'], empty);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /models refresh/);
});
