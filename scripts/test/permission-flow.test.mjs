import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { allowlistRetryOf, startRun, waitRun } from '../lib/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const node = process.execPath;
const entry = { id: 'devin/fake', harness: 'devin', displayName: 'Fake', slugTemplate: 'fake-{effort}', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true };

const PLAN = '# Plan p1\n\n## Scope\n- In scope: a.txt\n\n## Validation\n- Commands: `npm run lint` `npm test`\n';

function repoWithPlan() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-pf-'));
  spawnSync('git', ['init', '-q'], { cwd: repo, shell: false });
  const planPath = join(repo, '.orchestrator', 'plans', 'p1.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, PLAN);
  return { repo, planPath };
}

function blockedWorker(commands) {
  const steps = [
    {
      source: 'agent',
      tool_calls: commands.map((command, i) => ({ tool_call_id: `c${i}`, function_name: 'exec', arguments: { command } })),
      observation: { results: commands.map((_, i) => ({ source_call_id: `c${i}`, content: 'Tool execution was rejected by the user' })) },
    },
  ];
  return (
    "const fs=require('fs');const path=require('path');" +
    `fs.writeFileSync(path.join(process.argv[1],'devin-session.json'), ${JSON.stringify(JSON.stringify({ steps }))});` +
    "process.stderr.write('warning: rejected a tool call that requires confirmation.');"
  );
}

function launch({ repo, planPath, script, ...extra }) {
  return startRun({
    repo,
    planPath,
    klass: 'SMALL_FIX',
    entry,
    effort: 'medium',
    config,
    resolveExe: () => node,
    buildInvocation: ({ runDir }) => ({ exeName: 'node', args: ['-e', script, runDir], stdinPath: null, cwd: repo, permission: 'smart' }),
    projectRules: 'r',
    baseline: 'b',
    ...extra,
  });
}

test('a rejected plan command is classified from the session export and offers a specific allowlist', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = launch({ repo, planPath, script: blockedWorker(['npm run lint']) });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.equal(st.classification.status, 'PERMISSION_FAILURE');
  assert.equal(st.classification.action, 'retry-allowlist');
  assert.deepEqual(st.classification.allowExec, ['npm run lint']);
});

test('a rejected destructive command stops and offers no rules', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = launch({ repo, planPath, script: blockedWorker(['rm -f victim.txt']) });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.equal(st.classification.action, 'stop-reed');
  assert.deepEqual(st.classification.allowExec, []);
});

test('a forbidden command from the plan stays stopped because the run keeps the forbidden list', async () => {
  const { repo, planPath } = repoWithPlan();
  writeFileSync(planPath, `${PLAN}\n- Commands: \`git commit -m x\`\n`);
  const run = launch({ repo, planPath, script: blockedWorker(['git commit -m x']) });
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.equal(st.classification.action, 'stop-reed');
});

test('the retry run carries the extra rules and a second block does not loop', async () => {
  const { repo, planPath } = repoWithPlan();
  const first = launch({ repo, planPath, script: blockedWorker(['npx vitest run']) });
  const firstStatus = await waitRun({ repo, runId: first.runId, timeoutMs: 20000 });
  assert.equal(firstStatus.classification.action, 'stop-reed');

  writeFileSync(planPath, `${PLAN}\n## Steps\n1. Run \`npx vitest run\`.\n`);
  const a = launch({ repo, planPath, script: blockedWorker(['npx vitest run']) });
  const as = await waitRun({ repo, runId: a.runId, timeoutMs: 20000 });
  assert.equal(as.classification.action, 'retry-allowlist');

  const seen = blockedWorker(['npx vitest run']).replace("const fs=require('fs');", () => "const fs=require('fs');fs.writeFileSync('seen.json', fs.readFileSync('.devin/config.local.json','utf8'));");
  const retry = launch({ repo, planPath, script: seen, allowExec: as.classification.allowExec, retryOf: a.runId });
  const rs = await waitRun({ repo, runId: retry.runId, timeoutMs: 20000 });
  assert.ok(JSON.parse(readFileSync(join(repo, 'seen.json'), 'utf8')).permissions.allow.includes('Exec(npx vitest run)'));
  assert.equal(rs.classification.action, 'stop-reed');
  assert.equal(existsSync(join(repo, '.devin')), false);
});

test('allowlistRetryOf returns the rules of a run that offers an allowlist retry', async () => {
  const { repo, planPath } = repoWithPlan();
  const run = launch({ repo, planPath, script: blockedWorker(['npm test']) });
  await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.deepEqual(allowlistRetryOf({ repo, runId: run.runId }), { retryOf: run.runId, allowExec: ['npm test'], phase: 'BEFORE_WORK' });
});

test('allowlistRetryOf refuses unknown runs and runs that stopped for Reed', async () => {
  const { repo, planPath } = repoWithPlan();
  assert.throws(() => allowlistRetryOf({ repo, runId: 'nope' }), /Unknown run/);
  const run = launch({ repo, planPath, script: blockedWorker(['rm -f victim.txt']) });
  await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.throws(() => allowlistRetryOf({ repo, runId: run.runId }), /does not offer an allowlist retry/);
});
