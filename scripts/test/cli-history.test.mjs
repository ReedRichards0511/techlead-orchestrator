import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const orch = join(dirname(fileURLToPath(import.meta.url)), '..', 'orch.mjs');

function newState() {
  return mkdtempSync(join(tmpdir(), 'orch-ch-'));
}

function orchRun(state, args) {
  return spawnSync(process.execPath, [orch, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ORCH_STATE_DIR: state },
    timeout: 60000,
  });
}

function fakeRun(repo, runId, { klass = 'FEATURE', model = 'devin/swe-2', effort = 'high', resultStatus = 'SUCCESS', extraResult = {}, blocked = false, permission = 'smart', postflight = null, state = 'exited' } = {}) {
  const dir = join(repo, '.orchestrator', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const start = new Date('2026-10-12T10:00:00Z');
  const end = new Date(start.getTime() + 15 * 60000);
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      state,
      exitCode: 0,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      heartbeatAt: end.toISOString(),
      meta: { harness: 'devin', model, effort, klass, permission, planId: 'p1', planPath: join(repo, '.orchestrator', 'plans', 'p1.md'), heartbeatMs: 30000 },
    }),
  );
  writeFileSync(join(dir, 'stdout.log'), '');
  writeFileSync(join(dir, 'stderr.log'), blocked ? 'rejected a tool call that requires confirmation' : '');
  if (!blocked) writeFileSync(join(dir, 'result.json'), JSON.stringify({ status: resultStatus, summary: 's', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [], ...extraResult }));
  if (postflight) writeFileSync(join(dir, 'postflight.json'), JSON.stringify(postflight));
  return dir;
}

const repoDir = () => mkdtempSync(join(tmpdir(), 'orch-chr-'));
const readHistory = (state) => JSON.parse(readFileSync(join(state, 'history.json'), 'utf8'));

test('history on an empty state says there are no runs', () => {
  const r = orchRun(newState(), ['history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No runs recorded/);
});

test('history record stores the run and history --json exposes the aggregate', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a');
  const rec = orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'PASS', '--repo', repo, '--json']);
  assert.equal(rec.status, 0, rec.stderr + rec.stdout);
  const out = JSON.parse(rec.stdout);
  assert.equal(out.recorded.key, 'devin/swe-2@high');
  assert.equal(out.recorded.durationMin, 15);
  const h = readHistory(state);
  assert.equal(h.runs.length, 1);
  assert.equal(h.aggregates['devin/swe-2/high/FEATURE'].runs, 1);
  const show = orchRun(state, ['history', '--class', 'FEATURE', '--json']);
  assert.equal(JSON.parse(show.stdout).aggregates['devin/swe-2/high/FEATURE'].success, 1);
});

test('history record twice for the same run does not duplicate it', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a');
  orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'PASS', '--repo', repo]);
  const second = orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'REPAIR_REQUIRED', '--repairs', '1', '--repo', repo]);
  assert.equal(second.status, 0, second.stderr);
  const h = readHistory(state);
  assert.equal(h.runs.length, 1);
  assert.equal(h.aggregates['devin/swe-2/high/FEATURE'].repairRequired, 1);
});

test('history record reads scope and comment flags from postflight.json', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a', { postflight: { violations: [{ code: 'OUT_OF_SCOPE', severity: 'flag', path: 'C:\\Users\\x\\y.ts' }], comments: [{ file: 'a.ts', line: 1, text: 'private text' }] } });
  orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'PASS', '--repo', repo]);
  const run = readHistory(state).runs[0];
  assert.equal(run.scopeFlags, 1);
  assert.equal(run.commentFlags, 1);
  assert.doesNotMatch(readFileSync(join(state, 'history.json'), 'utf8'), /private text|Users/);
});

test('history record without a verdict on a SUCCESS run exits 2', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a');
  const r = orchRun(state, ['history', 'record', 'p1-a', '--repo', repo]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /verdict/i);
});

test('history record of an unknown or unfinished run fails without touching history.json', () => {
  const state = newState();
  const repo = repoDir();
  const missing = orchRun(state, ['history', 'record', 'nope', '--verdict', 'PASS', '--repo', repo]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Unknown run/);
  fakeRun(repo, 'p1-run', { state: 'running' });
  const running = orchRun(state, ['history', 'record', 'p1-run', '--verdict', 'PASS', '--repo', repo]);
  assert.notEqual(running.status, 0);
  assert.match(running.stderr, /not finished|still running/i);
  assert.throws(() => readFileSync(join(state, 'history.json')));
});

test('history record of a failed run needs no verdict and stores FAILED', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a', { resultStatus: 'PLAN_CONTRADICTION', extraResult: { planContradiction: { section: 'Steps', planAssumption: 'a', reality: 'b', evidence: 'c' } } });
  const r = orchRun(state, ['history', 'record', 'p1-a', '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rec = JSON.parse(r.stdout).recorded;
  assert.equal(rec.verdict, 'FAILED');
  assert.equal(rec.status, 'PLAN_CONTRADICTION');
});

test('history rejects an unknown subcommand', () => {
  const r = orchRun(newState(), ['history', 'wipe']);
  assert.equal(r.status, 2);
});

test('bootstrap status lists the three bootstrap classes', () => {
  const r = orchRun(newState(), ['bootstrap', 'status']);
  assert.equal(r.status, 0, r.stderr);
  for (const c of ['REFACTOR', 'MIGRATION', 'FEATURE']) assert.match(r.stdout, new RegExp(`Bootstrap 0/10 for ${c}`));
});

test('bootstrap status --class --json returns the report', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a');
  orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'PASS', '--repo', repo]);
  const r = orchRun(state, ['bootstrap', 'status', '--class', 'FEATURE', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.total, 1);
  assert.equal(rep.perKey['devin/swe-2@high'].passNoRepair, 1);
});

test('bootstrap end and reset need --class from the configured bootstrap classes', () => {
  const state = newState();
  assert.equal(orchRun(state, ['bootstrap', 'end']).status, 2);
  assert.equal(orchRun(state, ['bootstrap', 'reset']).status, 2);
  const bad = orchRun(state, ['bootstrap', 'end', '--class', 'SMALL_FIX']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bootstrap/i);
});

test('bootstrap end --promote stores the decision and reset clears it', () => {
  const state = newState();
  const end = orchRun(state, ['bootstrap', 'end', '--class', 'FEATURE', '--promote', 'devin/swe-2@high']);
  assert.equal(end.status, 0, end.stderr);
  assert.equal(readHistory(state).bootstrap.ended.FEATURE, true);
  assert.equal(readHistory(state).bootstrap.promoted.FEATURE, 'devin/swe-2@high');
  const reset = orchRun(state, ['bootstrap', 'reset', '--class', 'FEATURE']);
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(readHistory(state).bootstrap.ended.FEATURE, undefined);
  assert.ok(readHistory(state).bootstrap.resetAt.FEATURE);
});

test('bootstrap end --promote rejects a model that is not a candidate', () => {
  const r = orchRun(newState(), ['bootstrap', 'end', '--class', 'FEATURE', '--promote', 'codex/gpt-6.1-sol@medium']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /candidate/i);
});

test('history record accepts an audited verdict on a PERMISSION_FAILURE run', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a', { blocked: true });
  const r = orchRun(state, ['history', 'record', 'p1-a', '--verdict', 'PASS', '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const rec = JSON.parse(r.stdout).recorded;
  assert.equal(rec.status, 'PERMISSION_FAILURE');
  assert.equal(rec.verdict, 'PASS');
  assert.equal(rec.permissionRetry, 'blocked');
  assert.equal(readHistory(state).aggregates['devin/swe-2/high/FEATURE'].success, 1);
});

test('history record of a PERMISSION_FAILURE run without verdict stores FAILED', () => {
  const state = newState();
  const repo = repoDir();
  fakeRun(repo, 'p1-a', { blocked: true });
  const r = orchRun(state, ['history', 'record', 'p1-a', '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).recorded.verdict, 'FAILED');
});
