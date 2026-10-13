import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWindows } from '../lib/platform.mjs';

const orch = join(dirname(fileURLToPath(import.meta.url)), '..', 'orch.mjs');
const state = mkdtempSync(join(tmpdir(), 'orch-cr-'));
const real = { skip: !isWindows };

function orchRun(args, cwd) {
  return spawnSync(process.execPath, [orch, ...args], {
    encoding: 'utf8',
    shell: false,
    cwd,
    env: { ...process.env, ORCH_STATE_DIR: state },
    timeout: 90000,
  });
}

function repoWithRun(statusObj, files = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'orch-crr-'));
  const dir = join(repo, '.orchestrator', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  writeFileSync(join(repo, '.orchestrator', 'plans', 'p1.md'), '# plan');
  writeFileSync(join(dir, 'status.json'), JSON.stringify(statusObj));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return repo;
}

const goodResult = JSON.stringify({
  status: 'SUCCESS', summary: 's', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [],
});

test('status for an unknown run fails clearly', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-crr-'));
  const r = orchRun(['status', 'nope', '--repo', repo]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown run/);
});

test('status --json returns the classification of a finished run', () => {
  const now = new Date().toISOString();
  const repo = repoWithRun(
    { state: 'exited', exitCode: 0, startedAt: now, endedAt: now, meta: { harness: 'codex', permission: null } },
    { 'result.json': goodResult, 'stdout.log': '', 'stderr.log': '' },
  );
  const r = orchRun(['status', 'r1', '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).classification.status, 'SUCCESS');
});

test('status without --json prints a short summary', () => {
  const now = new Date().toISOString();
  const repo = repoWithRun(
    { state: 'exited', exitCode: 0, startedAt: now, endedAt: now, meta: { harness: 'codex' } },
    { 'result.json': goodResult, 'stdout.log': '', 'stderr.log': '' },
  );
  const r = orchRun(['status', 'r1', '--repo', repo]);
  assert.match(r.stdout, /r1/);
  assert.match(r.stdout, /SUCCESS/);
});

test('wait returns a still-running run after its own timeout', () => {
  const now = new Date().toISOString();
  const repo = repoWithRun({ state: 'running', pid: 1, startedAt: now, heartbeatAt: now, meta: { harness: 'codex', heartbeatMs: 30000 } });
  const r = orchRun(['wait', 'r1', '--repo', repo, '--timeout', '1', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).waiting, true);
});

test('wait returns immediately for a finished run', () => {
  const now = new Date().toISOString();
  const repo = repoWithRun(
    { state: 'exited', exitCode: 2, startedAt: now, endedAt: now, meta: { harness: 'codex' } },
    { 'stdout.log': '', 'stderr.log': 'boom' },
  );
  const r = orchRun(['wait', 'r1', '--repo', repo, '--json']);
  assert.equal(JSON.parse(r.stdout).classification.status, 'EXECUTION_FAILURE');
});

test('run without --plan or --class explains usage', () => {
  assert.equal(orchRun(['run']).status, 2);
  assert.equal(orchRun(['run', '--plan', 'x.md']).status, 2);
});

test('run with a missing plan fails before launching anything', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-crr-'));
  const r = orchRun(['run', '--plan', join(repo, 'ghost.md'), '--class', 'SMALL_FIX', '--repo', repo, '--model', 'devin/swe-2', '--effort', 'medium']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Plan not found|catalog/i);
});

test('run requires explicit model and effort before creating worker state or selecting automatically', () => {
  const repo = repoWithRun({ state: 'exited' });
  const base = ['run', '--plan', join(repo, '.orchestrator', 'plans', 'p1.md'), '--class', 'FEATURE', '--repo', repo];
  for (const selection of [[], ['--model', 'devin/swe-2'], ['--effort', 'high'], ['--model', '--effort', 'high']]) {
    const r = orchRun([...base, ...selection]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /explicit.*model.*effort|user.*selection/i);
    assert.deepEqual(readdirSync(join(repo, '.orchestrator', 'runs')), ['r1']);
    assert.equal(existsSync(join(repo, '.orchestrator', 'lock')), false);
  }
});

test('run preserves a chosen alternative and refuses a disabled choice without substitution', () => {
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  writeFileSync(plan, '# Plan p1\n## Scope\n- In scope: a.txt\n## Validation\n- Commands: `node -v`\n');
  const models = [
    { id: 'devin/gpt-6-1-sol', harness: 'devin', slugTemplate: 'gpt-6-1-sol-{effort}', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true },
    { id: 'codex/gpt-6.1-sol', harness: 'codex', slugTemplate: 'gpt-6.1-sol', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true },
  ];
  writeFileSync(join(state, 'catalog.json'), JSON.stringify({ models }));
  const args = ['run', '--plan', plan, '--class', 'FEATURE', '--repo', repo, '--model', 'codex/gpt-6.1-sol', '--effort', 'medium'];
  const chosen = orchRun(args);
  assert.equal(chosen.status, 1);
  assert.match(chosen.stderr, /real worker codex.*ORCH_FORBID_REAL_WORKERS/);
  const before = readdirSync(join(repo, '.orchestrator', 'runs'));
  models[1].enabled = false;
  writeFileSync(join(state, 'catalog.json'), JSON.stringify({ models }));
  const disabled = orchRun(args);
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /disabled/);
  assert.deepEqual(readdirSync(join(repo, '.orchestrator', 'runs')), before);
});

test('run validates the model, harness and effort against the catalog', real, () => {
  assert.equal(orchRun(['models', 'refresh']).status, 0);
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  const base = ['run', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo];
  let r = orchRun([...base, '--model', 'devin/nope', '--effort', 'high']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown model/i);
  r = orchRun([...base, '--model', 'devin/swe-2', '--effort', 'low']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /effort/i);
  r = orchRun([...base, '--model', 'codex/gpt-6.1-sol', '--effort', 'ultra']);
  assert.notEqual(r.status, 0);
  r = orchRun([...base, '--model', 'devin/swe-2', '--harness', 'codex', '--effort', 'high']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /harness/i);
  r = orchRun(['run', '--plan', plan, '--class', 'NOPE', '--repo', repo, '--model', 'devin/swe-2', '--effort', 'high']);
  assert.equal(r.status, 2);
});

test('run rejects --repair together with --continuation before launching', () => {
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  const r = orchRun(['run', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo, '--model', 'devin/nope', '--effort', 'high', '--repair', 'a.json', '--continuation', 'b.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /either --repair or --continuation/i);
});

test('run --repair fails clearly when the points file is missing or not JSON', () => {
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  const base = ['run', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo, '--model', 'devin/nope', '--effort', 'high'];
  let r = orchRun([...base, '--repair', join(repo, 'missing.json')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /repair file/i);
  const bad = join(repo, 'bad.json');
  writeFileSync(bad, '{not json');
  r = orchRun([...base, '--repair', bad]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /repair file/i);
});

test('run --repair requires a non-empty points list', () => {
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  const empty = join(repo, 'empty.json');
  writeFileSync(empty, JSON.stringify({ points: [] }));
  const r = orchRun(['run', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo, '--model', 'devin/nope', '--effort', 'high', '--repair', empty]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /points/i);
});

test('CLI run forwards project rules and preflight baseline before the test guard stops the worker', () => {
  const repo = repoWithRun({ state: 'exited' });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  writeFileSync(plan, '# Plan p1\n## Scope\n- In scope: a.txt\n## Validation\n- Commands: `node -v`\n');
  const rules = join(repo, '.orchestrator', 'plans', 'p1-project-rules.md');
  writeFileSync(rules, 'Preserve existing exports');
  mkdirSync(join(repo, '.orchestrator', 'snapshots'), { recursive: true });
  writeFileSync(join(repo, '.orchestrator', 'snapshots', 'p1.json'), JSON.stringify({ baseline: [{ command: 'node -v', passed: true, exitCode: 0 }] }));
  writeFileSync(join(state, 'catalog.json'), JSON.stringify({ models: [{ id: 'codex/fake', harness: 'codex', slugTemplate: 'fake', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true }] }));
  const r = orchRun(['run', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo, '--model', 'codex/fake', '--effort', 'medium', '--project-rules', rules]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ORCH_FORBID_REAL_WORKERS/);
  const dir = readdirSync(join(repo, '.orchestrator', 'runs')).find((name) => name.startsWith('p1-'));
  const packet = readFileSync(join(repo, '.orchestrator', 'runs', dir, 'packet.md'), 'utf8');
  assert.match(packet, /PROJECT_RULES: Preserve existing exports/);
  assert.match(packet, /BASELINE:.*node -v.*"passed":true/);
});
