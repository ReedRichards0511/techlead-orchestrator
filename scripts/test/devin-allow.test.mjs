import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { allowRulesFor, applyDevinAllowlist, restoreDevinAllowlist } from '../lib/devin-allow.mjs';
import { startRun, waitRun } from '../lib/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const node = process.execPath;

function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-da-'));
  spawnSync('git', ['init', '-q'], { cwd: repo, shell: false });
  const runDir = join(repo, '.orchestrator', 'runs', 'r1');
  mkdirSync(runDir, { recursive: true });
  return { repo, runDir };
}

const target = (repo) => join(repo, '.devin', 'config.local.json');
const readTarget = (repo) => JSON.parse(readFileSync(target(repo), 'utf8'));
const excluded = (repo) => readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');

test('allowRulesFor wraps each command in Exec(...) without duplicates or blanks', () => {
  assert.deepEqual(allowRulesFor(['npm run lint', ' npm test ', 'npm run lint', '']), ['Exec(npm run lint)', 'Exec(npm test)']);
  assert.deepEqual(allowRulesFor([]), []);
});

test('apply writes the allow rules, excludes the file from git and records a marker', () => {
  const { repo, runDir } = gitRepo();
  const r = applyDevinAllowlist({ repo, runDir, commands: ['npm run lint', 'npx vitest run'] });
  assert.equal(r.applied, true);
  assert.deepEqual(readTarget(repo).permissions.allow, ['Exec(npm run lint)', 'Exec(npx vitest run)']);
  assert.match(excluded(repo), /\.devin\/config\.local\.json/);
  assert.ok(existsSync(join(runDir, 'devin-allow.json')));
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', shell: false }).stdout.includes('.devin'), false);
});

test('apply does nothing when the plan has no validation commands', () => {
  const { repo, runDir } = gitRepo();
  const r = applyDevinAllowlist({ repo, runDir, commands: [] });
  assert.equal(r.applied, false);
  assert.equal(existsSync(target(repo)), false);
});

test('apply merges into an existing local config and restore puts the original back byte for byte', () => {
  const { repo, runDir } = gitRepo();
  mkdirSync(join(repo, '.devin'));
  const original = '{\n  "permissions": { "allow": ["Exec(git status)"], "deny": ["Exec(rm)"] },\n  "other": 1\n}\n';
  writeFileSync(target(repo), original);
  const r = applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  assert.equal(r.applied, true);
  const merged = readTarget(repo);
  assert.deepEqual(merged.permissions.allow, ['Exec(git status)', 'Exec(npm test)']);
  assert.deepEqual(merged.permissions.deny, ['Exec(rm)']);
  assert.equal(merged.other, 1);
  assert.equal(restoreDevinAllowlist({ repo, runDir }), true);
  assert.equal(readFileSync(target(repo), 'utf8'), original);
});

test('restore removes the file and the .devin directory that apply created, and is idempotent', () => {
  const { repo, runDir } = gitRepo();
  applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  assert.equal(restoreDevinAllowlist({ repo, runDir }), true);
  assert.equal(existsSync(join(repo, '.devin')), false);
  assert.equal(existsSync(join(runDir, 'devin-allow.json')), false);
  assert.equal(restoreDevinAllowlist({ repo, runDir }), false);
});

test('restore keeps a .devin directory that already had other files', () => {
  const { repo, runDir } = gitRepo();
  mkdirSync(join(repo, '.devin'));
  writeFileSync(join(repo, '.devin', 'config.json'), '{}');
  applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  restoreDevinAllowlist({ repo, runDir });
  assert.equal(existsSync(target(repo)), false);
  assert.ok(existsSync(join(repo, '.devin', 'config.json')));
});

test('an invalid existing local config is left untouched', () => {
  const { repo, runDir } = gitRepo();
  mkdirSync(join(repo, '.devin'));
  writeFileSync(target(repo), '{broken');
  const r = applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  assert.equal(r.applied, false);
  assert.match(r.reason, /not valid JSON/);
  assert.equal(readFileSync(target(repo), 'utf8'), '{broken');
  assert.equal(existsSync(join(runDir, 'devin-allow.json')), false);
});

const entry = (harness) => ({ id: `${harness}/fake`, harness, displayName: 'Fake', slugTemplate: 'fake-{effort}', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true });
const GOOD = JSON.stringify({ status: 'SUCCESS', summary: 'ok', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [] });

function launch({ harness = 'devin', permission, cfg = config } = {}) {
  const { repo } = gitRepo();
  const planPath = join(repo, '.orchestrator', 'plans', 'plan1.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# Plan plan1\n\n## Scope\n- In scope: a.txt\n\n## Validation\n- Commands: `npm run lint` `npx vitest run`\n');
  const script =
    "const fs=require('fs');" +
    "fs.writeFileSync('seen.json', fs.existsSync('.devin/config.local.json') ? fs.readFileSync('.devin/config.local.json','utf8') : 'ABSENT');" +
    `fs.writeFileSync(process.argv[1], ${JSON.stringify(GOOD)});`;
  const run = startRun({
    repo,
    planPath,
    klass: 'SMALL_FIX',
    entry: entry(harness),
    effort: 'medium',
    config: cfg,
    resolveExe: () => node,
    buildInvocation: ({ resultPath }) => ({ exeName: 'node', args: ['-e', script, resultPath], stdinPath: null, cwd: repo, permission }),
    projectRules: 'rules',
    baseline: 'baseline',
  });
  return { repo, run };
}

test('a restricted Devin run sees the allowlist while it runs and it is removed once the run is read as finished', async () => {
  const { repo, run } = launch({ permission: 'smart' });
  assert.equal(run.devinAllowlist.applied, true);
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.equal(st.classification.status, 'SUCCESS');
  const seen = JSON.parse(readFileSync(join(repo, 'seen.json'), 'utf8'));
  assert.deepEqual(seen.permissions.allow, ['Exec(npm run lint)', 'Exec(npx vitest run)']);
  assert.equal(existsSync(join(repo, '.devin')), false);
  const events = readFileSync(join(run.runDir, 'events.jsonl'), 'utf8');
  assert.match(events, /"type":"allowlist","applied":true,"rules":2/);
});

test('no allowlist for dangerous mode, other harnesses or when the config disables it', async () => {
  for (const [label, opts] of [
    ['dangerous', { permission: 'dangerous' }],
    ['codex', { harness: 'codex' }],
    ['disabled', { permission: 'smart', cfg: { ...config, permissions: { ...config.permissions, devin: { ...config.permissions.devin, allowlist: false } } } }],
  ]) {
    const { repo, run } = launch(opts);
    assert.equal(run.devinAllowlist.applied, false, label);
    await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
    assert.equal(readFileSync(join(repo, 'seen.json'), 'utf8'), 'ABSENT', label);
  }
});
