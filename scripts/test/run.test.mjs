import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startRun, getStatus, waitRun } from '../lib/run.mjs';
import { gitPorcelain } from '../lib/git.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const node = process.execPath;

const entry = (harness = 'devin') => ({
  id: `${harness}/fake`,
  harness,
  displayName: 'Fake',
  slugTemplate: 'fake-{effort}',
  efforts: ['medium'],
  allowedEfforts: ['medium'],
  enabled: true,
});

function repoWithPlan() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-run-'));
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  const planPath = join(repo, '.orchestrator', 'plans', 'plan1.md');
  writeFileSync(planPath, '# Plan plan1\n');
  return { repo, planPath };
}

const goodResult = JSON.stringify({
  status: 'SUCCESS',
  summary: 'ok',
  modifiedFiles: [],
  planStepsCompleted: ['1'],
  validation: [],
  errors: [],
});

function fakeBuilder(script) {
  return ({ repo, resultPath }) => ({
    exeName: 'node',
    args: ['-e', script.replaceAll('__RESULT__', JSON.stringify(resultPath)).replaceAll('__GOOD__', JSON.stringify(goodResult))],
    stdinPath: null,
    cwd: repo,
  });
}

const launch = (extra = {}) => {
  const { repo, planPath } = repoWithPlan();
  const run = startRun({
    repo,
    planPath,
    klass: 'SMALL_FIX',
    entry: entry(extra.harness),
    effort: 'medium',
    config,
    resolveExe: () => node,
    buildInvocation: fakeBuilder(extra.script ?? "require('fs').writeFileSync(__RESULT__, __GOOD__)"),
    timeouts: extra.timeouts,
    projectRules: 'rules',
    baseline: 'baseline',
    packetText: extra.packetText,
    packetKind: extra.packetKind,
    packetData: extra.packetData,
  });
  return { repo, planPath, run };
};

test('startRun lays out the run directory and returns immediately', async () => {
  const t0 = Date.now();
  const { repo, run } = launch();
  assert.ok(Date.now() - t0 < 2000);
  assert.match(run.runId, /^plan1-\d{8}T\d{6}/);
  assert.ok(existsSync(join(run.runDir, 'packet.md')));
  assert.ok(existsSync(join(run.runDir, 'status.json')));
  const events = readFileSync(join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events[0].type, 'launch');
  assert.equal(events[0].harness, 'devin');
  assert.equal(run.runDir, join(repo, '.orchestrator', 'runs', run.runId));
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('packet.md points at the plan and result path', async () => {
  const { repo, planPath, run } = launch();
  const packet = readFileSync(join(run.runDir, 'packet.md'), 'utf8');
  assert.ok(packet.includes(`PLAN_PATH: ${planPath}`));
  assert.ok(packet.includes(`RESULT_PATH: ${join(run.runDir, 'result.json')}`));
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('a supplied packet text replaces the generated one', async () => {
  const { repo, run } = launch({ packetText: '# CUSTOM REPAIR PACKET' });
  assert.equal(readFileSync(join(run.runDir, 'packet.md'), 'utf8'), '# CUSTOM REPAIR PACKET');
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('a repair kind renders a repair packet bound to the new run', async () => {
  const { repo, planPath, run } = launch({
    packetKind: 'repair',
    packetData: { cycle: 2, points: [{ file: 'src/a.ts', line: 7, issue: 'missing export', expected: 'export foo' }], commands: ['npm test'] },
  });
  const packet = readFileSync(join(run.runDir, 'packet.md'), 'utf8');
  assert.match(packet, /REPAIR PACKET \(cycle 2\)/);
  assert.ok(packet.includes(run.runId));
  assert.ok(packet.includes(`PLAN_PATH: ${planPath}`));
  assert.ok(packet.includes(`RESULT_PATH: ${join(run.runDir, 'result.json')}`));
  assert.ok(packet.includes('src/a.ts:7'));
  assert.ok(packet.includes('NO_COMMENTS_POLICY'));
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('a continuation kind renders a continuation packet bound to the new run', async () => {
  const { repo, run } = launch({
    packetKind: 'continuation',
    packetData: { done: ['step 1'], missing: ['step 2'], changedFiles: ['src/a.ts'], resumeAt: 'step 2' },
  });
  const packet = readFileSync(join(run.runDir, 'packet.md'), 'utf8');
  assert.match(packet, /CONTINUATION PACKET/);
  assert.ok(packet.includes('- step 2'));
  assert.ok(packet.includes('RESUME_AT: step 2'));
  assert.ok(packet.includes(`RESULT_PATH: ${join(run.runDir, 'result.json')}`));
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('an unknown packet kind is rejected before anything is launched', () => {
  assert.throws(() => launch({ packetKind: 'bogus', packetData: {} }), /packet kind/i);
});

test('a finished run with a valid result.json classifies as SUCCESS', async () => {
  const { repo, run } = launch();
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.state, 'exited');
  assert.equal(st.classification.status, 'SUCCESS');
  assert.equal(st.classification.action, 'postflight');
  assert.equal(st.meta.harness, 'devin');
  assert.equal(st.meta.effort, 'medium');
});

test('the Devin silent block is detected from stderr', async () => {
  const { repo, run } = launch({ script: "console.error('warning: rejected a tool call that requires confirmation. Running in non-interactive mode.')" });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.classification.status, 'PERMISSION_FAILURE');
  assert.equal(st.classification.action, 'retry-dangerous');
});

test('a non-zero exit without result.json is EXECUTION_FAILURE', async () => {
  const { repo, run } = launch({ harness: 'codex', script: 'process.exit(3)' });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.classification.status, 'EXECUTION_FAILURE');
});

test('an invalid result.json is flagged and not trusted', async () => {
  const { repo, run } = launch({ script: "require('fs').writeFileSync(__RESULT__, '{\"status\":\"NOPE\"}')" });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.classification.status, 'UNKNOWN_FAILURE');
  assert.match(st.classification.detail, /result\.json/);
});

test('wall-clock timeout is classified TIMEOUT', async () => {
  const { repo, run } = launch({ script: 'setInterval(()=>{},1000)', timeouts: { wallMs: 1200 } });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.state, 'timeout');
  assert.equal(st.classification.status, 'TIMEOUT');
});

test('waitRun reports a still-running run when its own timeout expires', async () => {
  const { repo, run } = launch({ script: 'setTimeout(()=>{},4000)' });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 600 });
  assert.equal(st.waiting, true);
  assert.ok(['starting', 'running'].includes(st.state));
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
});

test('getStatus returns null for an unknown run', () => {
  const { repo } = repoWithPlan();
  assert.equal(getStatus({ repo, runId: 'nope' }), null);
});

test('a running run with a stale heartbeat is reported as lost', () => {
  const { repo } = repoWithPlan();
  const dir = join(repo, '.orchestrator', 'runs', 'r1');
  mkdirSync(dir, { recursive: true });
  const old = new Date(Date.now() - 10 * 60000).toISOString();
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({ state: 'running', pid: 999999, startedAt: old, heartbeatAt: old, meta: { harness: 'devin', heartbeatMs: 30000 } }),
  );
  const st = getStatus({ repo, runId: 'r1' });
  assert.equal(st.lost, true);
});

test('startRun fails clearly when the executable cannot be found', () => {
  const { repo, planPath } = repoWithPlan();
  assert.throws(
    () =>
      startRun({
        repo, planPath, klass: 'SMALL_FIX', entry: entry(), effort: 'medium', config,
        resolveExe: () => null,
        buildInvocation: fakeBuilder('1'),
      }),
    /not found/i,
  );
});

test('startRun fails when the plan does not exist', () => {
  const { repo } = repoWithPlan();
  assert.throws(
    () =>
      startRun({
        repo, planPath: join(repo, 'ghost.md'), klass: 'SMALL_FIX', entry: entry(), effort: 'medium', config,
        resolveExe: () => node,
        buildInvocation: fakeBuilder('1'),
      }),
    /plan/i,
  );
});

test('a failure after the worker touched the tree is DURING_WORK', async () => {
  const { repo, planPath } = repoWithPlan();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), 'x');
  const porcelain = await gitPorcelain(repo);
  const run = startRun({
    repo, planPath, klass: 'SMALL_FIX', entry: entry('codex'), effort: 'medium', config,
    resolveExe: () => node,
    buildInvocation: fakeBuilder("require('fs').writeFileSync('b.txt','y');process.exit(3)"),
    snapshot: { porcelain },
  });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.classification.status, 'EXECUTION_FAILURE');
  assert.equal(st.classification.phase, 'DURING_WORK');
  assert.equal(st.classification.action, 'continuation');
});

test('a failure with an untouched tree is BEFORE_WORK and falls back', async () => {
  const { repo, planPath } = repoWithPlan();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const porcelain = await gitPorcelain(repo);
  const run = startRun({
    repo, planPath, klass: 'SMALL_FIX', entry: entry('codex'), effort: 'medium', config,
    resolveExe: () => node,
    buildInvocation: fakeBuilder('process.exit(3)'),
    snapshot: { porcelain },
  });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  assert.equal(st.classification.phase, 'BEFORE_WORK');
  assert.equal(st.classification.action, 'fallback');
});

test('gitPorcelain ignores the .orchestrator directory', async () => {
  const { repo } = repoWithPlan();
  spawnSync('git', ['init', '-q'], { cwd: repo });
  assert.equal(await gitPorcelain(repo), '');
  writeFileSync(join(repo, 'new.txt'), 'x');
  assert.match(await gitPorcelain(repo), /new\.txt/);
});

test('events.jsonl records the end of the run', async () => {
  const { repo, run } = launch();
  await waitRun({ repo, runId: run.runId, timeoutMs: 15000 });
  const events = readFileSync(join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some((e) => e.type === 'launch'));
  const finish = events.filter((e) => e.type === 'finish');
  assert.equal(finish.length, 1);
  assert.equal(finish[0].classification, 'SUCCESS');
  getStatus({ repo, runId: run.runId });
  const again = readFileSync(join(run.runDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(again.filter((e) => e.type === 'finish').length, 1);
});
