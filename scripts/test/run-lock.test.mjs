import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startRun, waitRun } from '../lib/run.mjs';
import { acquireLock, readLock } from '../lib/safety.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const node = process.execPath;

const entry = {
  id: 'devin/fake',
  harness: 'devin',
  displayName: 'Fake',
  slugTemplate: 'fake-{effort}',
  efforts: ['medium'],
  allowedEfforts: ['medium'],
  enabled: true,
};

function repoWithPlan() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-lock-'));
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  const planPath = join(repo, '.orchestrator', 'plans', 'plan1.md');
  writeFileSync(planPath, '# Plan plan1\n## Scope\n- In scope: a.txt\n## Validation\n- Commands: `node -v`\n');
  return { repo, planPath };
}

const goodResult = JSON.stringify({
  status: 'SUCCESS', summary: 'ok', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [],
});

const builder = (script) => ({ repo, resultPath }) => ({
  exeName: 'node',
  args: ['-e', script.replaceAll('__RESULT__', JSON.stringify(resultPath)).replaceAll('__GOOD__', JSON.stringify(goodResult))],
  stdinPath: null,
  cwd: repo,
});

const WRITE_RESULT = "require('fs').writeFileSync(__RESULT__, __GOOD__)";

function start(repo, planPath, script, extra = {}) {
  return startRun({
    repo, planPath, klass: 'SMALL_FIX', entry, effort: 'medium', config,
    resolveExe: () => node,
    buildInvocation: builder(script),
    ...extra,
  });
}

test('startRun refuses to run while another plan holds the lock', () => {
  const { repo, planPath } = repoWithPlan();
  acquireLock({ repo, planId: 'other-plan' });
  assert.throws(() => start(repo, planPath, '1'), /locked/i);
});

test('startRun records the run and supervisor in the lock', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = start(repo, planPath, WRITE_RESULT);
  const lock = readLock(repo);
  assert.equal(lock.planId, 'plan1');
  assert.equal(lock.runId, run.runId);
  assert.equal(lock.pid, run.supervisorPid);
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('a second run of the same plan is refused while the first is still running', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = start(repo, planPath, 'setTimeout(()=>{},3000)');
  assert.throws(() => start(repo, planPath, '1'), /still running/i);
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  const again = start(repo, planPath, WRITE_RESULT, { now: new Date(Date.now() + 5000) });
  assert.notEqual(again.runId, run.runId);
  await waitRun({ repo, runId: again.runId, timeoutMs: 15000 });
});

test('each run snapshots the working tree state at launch', async () => {
  const { repo, planPath } = repoWithPlan();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'pre.txt'), 'x');
  const run = start(repo, planPath, WRITE_RESULT);
  const snap = JSON.parse(readFileSync(join(run.runDir, 'snapshot.json'), 'utf8'));
  assert.match(snap.porcelain, /pre\.txt/);
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('run metadata carries the plan identity for postflight', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = start(repo, planPath, WRITE_RESULT);
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.meta.planId, 'plan1');
  assert.equal(st.meta.planPath, planPath);
});
