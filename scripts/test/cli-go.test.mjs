import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const orch = join(dirname(fileURLToPath(import.meta.url)), '..', 'orch.mjs');
const state = mkdtempSync(join(tmpdir(), 'orch-go-'));
const run = (args) => spawnSync(process.execPath, [orch, ...args], { encoding: 'utf8', env: { ...process.env, ORCH_STATE_DIR: state }, timeout: 60000 });

function repoWithPlan() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-gor-'));
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  const plan = join(repo, '.orchestrator', 'plans', 'task.md');
  writeFileSync(plan, '# Plan\n## Scope\n- In scope: src/\n## Validation\n- Commands: `node -v`\n');
  return { repo, plan };
}

test('go requires the chosen model and effort before any preflight', () => {
  const { repo, plan } = repoWithPlan();
  const r = run(['go', '--plan', plan, '--class', 'SMALL_FIX', '--repo', repo]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /run_in_background/);
  assert.equal(existsSync(join(repo, '.orchestrator', 'lock')), false);
});

test('go runs the preflight on the first launch and stops when it fails', () => {
  const { repo, plan } = repoWithPlan();
  const r = run(['go', '--plan', plan, '--class', 'SMALL_FIX', '--model', 'codex/gpt-6.1-sol', '--effort', 'medium', '--repo', repo]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PREFLIGHT FAILED: Not a git repository/);
  assert.equal(existsSync(join(repo, '.orchestrator', 'runs')), false);
});

test('go reuses an existing snapshot instead of replacing the baseline', () => {
  const { repo, plan } = repoWithPlan();
  mkdirSync(join(repo, '.orchestrator', 'snapshots'), { recursive: true });
  writeFileSync(join(repo, '.orchestrator', 'snapshots', 'task.json'), '{}');
  const r = run(['go', '--plan', plan, '--class', 'SMALL_FIX', '--model', 'nope/model', '--effort', 'medium', '--repo', repo]);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /PREFLIGHT/);
  assert.match(r.stderr, /Unknown model|No catalog/);
});

test('close releases the task lock and prints the token report last', () => {
  const { repo } = repoWithPlan();
  const transcript = join(repo, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'p', message: { content: 'go' } })}\n`);
  assert.equal(run(['usage', 'start', '--task', 'task', '--transcript', transcript, '--repo', repo]).status, 0);
  writeFileSync(join(repo, '.orchestrator', 'lock'), JSON.stringify({ planId: 'task', runId: null, pid: null }));
  const r = run(['close', '--task', 'task', '--repo', repo]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(repo, '.orchestrator', 'lock')), false);
  assert.match(r.stdout, /Lock released\.[\s\S]*Total medido/);
  assert.ok(readdirSync(join(repo, '.orchestrator', 'usage')).includes('task.json'));
});

test('close leaves a lock of another plan alone', () => {
  const { repo } = repoWithPlan();
  writeFileSync(join(repo, '.orchestrator', 'lock'), JSON.stringify({ planId: 'other', runId: null, pid: null }));
  run(['close', '--task', 'task', '--repo', repo]);
  assert.equal(existsSync(join(repo, '.orchestrator', 'lock')), true);
});
