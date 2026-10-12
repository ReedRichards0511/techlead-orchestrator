import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startRun } from '../lib/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const entry = { id: 'devin/fake', harness: 'devin', displayName: 'Fake', slugTemplate: 'fake-{effort}', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true };

function repoWithPlan() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-guard-'));
  spawnSync('git', ['init', '-q'], { cwd: repo, shell: false });
  const planPath = join(repo, '.orchestrator', 'plans', 'p1.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# Plan p1\n');
  return { repo, planPath };
}

function launch(exeName) {
  const { repo, planPath } = repoWithPlan();
  return startRun({
    repo,
    planPath,
    klass: 'SMALL_FIX',
    entry,
    effort: 'medium',
    config: { permissions: { devin: { allowlist: false } } },
    resolveExe: () => node,
    buildInvocation: () => ({ exeName, args: ['-e', ''], stdinPath: null, cwd: repo, permission: 'smart' }),
    projectRules: 'r',
    baseline: 'b',
  });
}

test('the test runner forbids launching real worker CLIs', () => {
  assert.equal(process.env.ORCH_FORBID_REAL_WORKERS, '1');
});

test('startRun refuses to launch devin, codex or agy while the guard is on', () => {
  for (const name of ['devin', 'codex', 'agy']) {
    assert.throws(() => launch(name), /real worker/i, name);
  }
});

test('startRun still launches a stand-in executable while the guard is on', () => {
  const run = launch('node');
  assert.ok(run.runId);
});

test('npm test loads the guard for every test file', () => {
  const pkg = JSON.parse(spawnSync(node, ['-p', 'JSON.stringify(require("./package.json"))'], { cwd: join(here, '..', '..'), encoding: 'utf8', shell: false }).stdout);
  assert.match(pkg.scripts.test, /--import \.\/scripts\/test\/guard\.mjs/);
});
