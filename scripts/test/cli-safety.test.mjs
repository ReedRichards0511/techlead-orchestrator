import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const orch = join(dirname(fileURLToPath(import.meta.url)), '..', 'orch.mjs');
const state = mkdtempSync(join(tmpdir(), 'orch-cs-'));

function orchRun(args) {
  return spawnSync(process.execPath, [orch, ...args], {
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ORCH_STATE_DIR: state },
    timeout: 90000,
  });
}

const git = (repo, ...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', shell: false }).stdout.trim();

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-csr-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'tester');
  writeFileSync(join(repo, 'a.txt'), 'hello\n');
  writeFileSync(join(repo, 'b.txt'), 'other\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  const plan = join(repo, '.orchestrator', 'plans', 'p1.md');
  writeFileSync(plan, '# Plan p1\n\n## Scope\n- In scope: a.txt\n- Out of scope: rest\n\n## Validation\n- Commands: `node -v`\n');
  return { repo, plan };
}

function fakeRun(repo, runId, { resultStatus = 'SUCCESS', state: st = 'exited' } = {}) {
  const dir = join(repo, '.orchestrator', 'runs', runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      state: st,
      exitCode: 0,
      startedAt: now,
      endedAt: now,
      heartbeatAt: now,
      meta: { harness: 'codex', planId: 'p1', planPath: join(repo, '.orchestrator', 'plans', 'p1.md'), heartbeatMs: 30000 },
    }),
  );
  writeFileSync(join(dir, 'stdout.log'), '');
  writeFileSync(join(dir, 'stderr.log'), '');
  writeFileSync(
    join(dir, 'result.json'),
    JSON.stringify({ status: resultStatus, summary: 's', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [] }),
  );
  return dir;
}

test('preflight --json locks the repo and writes the snapshot', () => {
  const { repo, plan } = makeRepo();
  const r = orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.ok(existsSync(join(repo, '.orchestrator', 'snapshots', 'p1.json')));
  assert.ok(existsSync(join(repo, '.orchestrator', 'lock')));
});

test('preflight on a dirty tree exits non-zero and lists the files', () => {
  const { repo, plan } = makeRepo();
  writeFileSync(join(repo, 'mine.txt'), 'x');
  const r = orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.needsConfirmation, true);
  assert.deepEqual(out.dirtyFiles, ['mine.txt']);
  assert.equal(orchRun(['preflight', '--plan', plan, '--repo', repo, '--accept-dirty', '--json']).status, 0);
});

test('unlock needs --yes and refuses a live holder without --force', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  const lockPath = join(repo, '.orchestrator', 'lock');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(orchRun(['unlock', '--repo', repo]).status, 2);
  assert.ok(existsSync(lockPath));
  writeFileSync(lockPath, JSON.stringify({ ...lock, pid: process.pid }));
  const live = orchRun(['unlock', '--repo', repo, '--yes']);
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /running|live/i);
  assert.equal(orchRun(['unlock', '--repo', repo, '--yes', '--force']).status, 0);
  assert.equal(existsSync(lockPath), false);
});

test('unlock releases a finished plan lock with --yes', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  assert.equal(orchRun(['unlock', '--repo', repo, '--yes']).status, 0);
  assert.equal(existsSync(join(repo, '.orchestrator', 'lock')), false);
});

test('postflight passes a clean in-scope change', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  writeFileSync(join(repo, 'a.txt'), 'hello\nOK\n');
  fakeRun(repo, 'r1');
  const r = orchRun(['postflight', 'r1', '--repo', repo, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.changedFiles.map((f) => f.path), ['a.txt']);
  assert.equal(out.classification.status, 'SUCCESS');
  assert.equal(out.validation.regressions.length, 0);
  assert.ok(existsSync(join(repo, '.orchestrator', 'runs', 'r1', 'postflight.json')));
});

test('postflight fails with a recovery hint when the worker committed', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  const head = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'a.txt'), 'hello\nOK\n');
  git(repo, 'commit', '-qam', 'worker commit');
  fakeRun(repo, 'r1');
  const r = orchRun(['postflight', 'r1', '--repo', repo, '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.violations.some((v) => v.code === 'HEAD_MOVED'));
  assert.ok(out.recovery.some((c) => c.includes(head)));
});

test('postflight reports validation regressions against the baseline', () => {
  const { repo, plan } = makeRepo();
  writeFileSync(plan, readFileSync(plan, 'utf8').replace('`node -v`', '`node check.js`'));
  writeFileSync(join(repo, 'check.js'), 'process.exit(0)\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add check');
  const pre = orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  assert.equal(pre.status, 0, pre.stdout);
  writeFileSync(join(repo, 'a.txt'), 'hello\nOK\n');
  writeFileSync(join(repo, 'check.js'), 'process.exit(1)\n');
  fakeRun(repo, 'r1');
  const r = orchRun(['postflight', 'r1', '--repo', repo, '--json']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.validation.regressions.map((x) => x.command), ['node check.js']);
  assert.equal(r.status, 1);
});

test('postflight --skip-validate skips re-validation', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  fakeRun(repo, 'r1');
  const out = JSON.parse(orchRun(['postflight', 'r1', '--repo', repo, '--skip-validate', '--json']).stdout);
  assert.equal(out.validation.skipped, true);
});

test('postflight without a snapshot asks for preflight', () => {
  const { repo } = makeRepo();
  fakeRun(repo, 'r1');
  const r = orchRun(['postflight', 'r1', '--repo', repo, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /preflight/);
});

test('postflight refuses a run that is still running', () => {
  const { repo, plan } = makeRepo();
  orchRun(['preflight', '--plan', plan, '--repo', repo, '--json']);
  fakeRun(repo, 'r1', { state: 'running' });
  const r = orchRun(['postflight', 'r1', '--repo', repo, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /running/i);
});

test('postflight for an unknown run fails', () => {
  const { repo } = makeRepo();
  const r = orchRun(['postflight', 'nope', '--repo', repo, '--json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown run/);
});
