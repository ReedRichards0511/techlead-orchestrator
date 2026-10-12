import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { applyDevinAllowlist, restoreDevinAllowlist, restorePendingAllowlists } from '../lib/devin-allow.mjs';
import { startRun, waitRun } from '../lib/run.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const node = process.execPath;
const git = (repo, args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false }).stdout;

function gitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-dp-'));
  spawnSync('git', ['init', '-q'], { cwd: repo, shell: false });
  return repo;
}

const target = (repo) => join(repo, '.devin', 'config.local.json');
const runDirOf = (repo, id) => {
  const d = join(repo, '.orchestrator', 'runs', id);
  mkdirSync(d, { recursive: true });
  return d;
};
const excludeFile = (repo) => join(repo, '.git', 'info', 'exclude');
const readBytes = (p) => readFileSync(p);

test('an original with a BOM, CRLF and no trailing newline comes back byte for byte', () => {
  const repo = gitRepo();
  mkdirSync(join(repo, '.devin'));
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n  "permissions": { "allow": ["Exec(git status)"] }\r\n}', 'utf8')]);
  writeFileSync(target(repo), original);
  const runDir = runDirOf(repo, 'r1');
  const r = applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  assert.equal(r.applied, true);
  assert.deepEqual(JSON.parse(readFileSync(target(repo), 'utf8')).permissions.allow, ['Exec(git status)', 'Exec(npm test)']);
  restoreDevinAllowlist({ repo, runDir });
  assert.ok(readBytes(target(repo)).equals(original));
});

test('an original with bytes that are not valid UTF-8 is left alone instead of being rewritten', () => {
  const repo = gitRepo();
  mkdirSync(join(repo, '.devin'));
  const original = Buffer.concat([Buffer.from('{"permissions":{"allow":[]},"note":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]);
  writeFileSync(target(repo), original);
  const r = applyDevinAllowlist({ repo, runDir: runDirOf(repo, 'r1'), commands: ['npm test'] });
  assert.equal(r.applied, false);
  assert.ok(readBytes(target(repo)).equals(original));
});

test('restore removes the exclude line it added and keeps every other line byte for byte', () => {
  const repo = gitRepo();
  mkdirSync(dirname(excludeFile(repo)), { recursive: true });
  const before = '# user rules\r\n*.log\r\nsecrets/\r\n';
  writeFileSync(excludeFile(repo), before);
  const runDir = runDirOf(repo, 'r1');
  applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  assert.match(readFileSync(excludeFile(repo), 'utf8'), /\.devin\/config\.local\.json/);
  restoreDevinAllowlist({ repo, runDir });
  assert.equal(readFileSync(excludeFile(repo), 'utf8'), before);
});

test('restore keeps an exclude line the user already had', () => {
  const repo = gitRepo();
  mkdirSync(dirname(excludeFile(repo)), { recursive: true });
  const before = '.devin/config.local.json\n';
  writeFileSync(excludeFile(repo), before);
  const runDir = runDirOf(repo, 'r1');
  applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
  restoreDevinAllowlist({ repo, runDir });
  assert.equal(readFileSync(excludeFile(repo), 'utf8'), before);
});

test('an unrestored earlier run does not become the "original" of the next run', () => {
  const repo = gitRepo();
  mkdirSync(join(repo, '.devin'));
  const original = '{"permissions":{"allow":["Exec(git status)"]}}\n';
  writeFileSync(target(repo), original);
  const r1 = runDirOf(repo, 'r1');
  const r2 = runDirOf(repo, 'r2');
  applyDevinAllowlist({ repo, runDir: r1, commands: ['npm run lint'] });
  applyDevinAllowlist({ repo, runDir: r2, commands: ['npm test'] });
  const live = JSON.parse(readFileSync(target(repo), 'utf8')).permissions.allow;
  assert.deepEqual(live, ['Exec(git status)', 'Exec(npm test)']);
  restoreDevinAllowlist({ repo, runDir: r2 });
  assert.equal(readFileSync(target(repo), 'utf8'), original);
  assert.equal(existsSync(join(r1, 'devin-allow.json')), false);
});

test('restorePendingAllowlists restores every run that left a marker and reports them', () => {
  const repo = gitRepo();
  const r1 = runDirOf(repo, 'r1');
  applyDevinAllowlist({ repo, runDir: r1, commands: ['npm test'] });
  assert.ok(existsSync(target(repo)));
  assert.deepEqual(restorePendingAllowlists(repo), ['r1']);
  assert.equal(existsSync(join(repo, '.devin')), false);
  assert.deepEqual(restorePendingAllowlists(repo), []);
});

test('apply then restore twice leaves git status and the exclude file exactly as they started', () => {
  const repo = gitRepo();
  mkdirSync(join(repo, '.devin'));
  writeFileSync(target(repo), '{"permissions":{"allow":["Exec(git status)"]}}\n');
  const statusBefore = git(repo, ['status', '--porcelain', '-uall']);
  const excludeBefore = existsSync(excludeFile(repo)) ? readFileSync(excludeFile(repo), 'utf8') : '';
  for (const id of ['r1', 'r2']) {
    const runDir = runDirOf(repo, id);
    applyDevinAllowlist({ repo, runDir, commands: ['npm test'] });
    restoreDevinAllowlist({ repo, runDir });
  }
  const filtered = (s) => s.split('\n').filter((l) => !l.includes('.orchestrator')).join('\n');
  assert.equal(filtered(git(repo, ['status', '--porcelain', '-uall'])), filtered(statusBefore));
  assert.equal(existsSync(excludeFile(repo)) ? readFileSync(excludeFile(repo), 'utf8') : '', excludeBefore);
});

const entry = { id: 'devin/fake', harness: 'devin', displayName: 'Fake', slugTemplate: 'fake-{effort}', efforts: ['medium'], allowedEfforts: ['medium'], enabled: true };
const GOOD = JSON.stringify({ status: 'SUCCESS', summary: 'ok', modifiedFiles: [], planStepsCompleted: ['1'], validation: [], errors: [] });
const CONTRADICTION = JSON.stringify({
  status: 'PLAN_CONTRADICTION', summary: 's', modifiedFiles: [], planStepsCompleted: [], validation: [], errors: [],
  planContradiction: { section: 's', planAssumption: 'a', reality: 'b', evidence: 'e' },
});
const BLOCKED = "process.stderr.write('warning: rejected a tool call that requires confirmation.')";
const QUOTA = "process.stderr.write('You exceeded your current quota');process.exit(1)";

const ORIGINAL = '{\n  "permissions": { "allow": ["Exec(git status)"], "deny": ["Exec(rm)"] }\n}';

function runWithOriginal(script, { wallMs } = {}) {
  const repo = gitRepo();
  mkdirSync(join(repo, '.devin'));
  writeFileSync(target(repo), ORIGINAL);
  const planPath = join(repo, '.orchestrator', 'plans', 'p1.md');
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath, '# Plan p1\n\n## Scope\n- In scope: a.txt\n\n## Validation\n- Commands: `npm test`\n');
  const run = startRun({
    repo,
    planPath,
    klass: 'SMALL_FIX',
    entry,
    effort: 'medium',
    config,
    resolveExe: () => node,
    buildInvocation: ({ resultPath }) => ({ exeName: 'node', args: ['-e', script, resultPath], stdinPath: null, cwd: repo, permission: 'smart' }),
    timeouts: wallMs ? { wallMs, idleMs: 0 } : {},
    projectRules: 'r',
    baseline: 'b',
  });
  return { repo, run };
}

async function untilRestored(repo, runDir) {
  for (let i = 0; i < 100; i++) {
    if (!existsSync(join(runDir, 'devin-allow.json'))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const SCENARIOS = {
  SUCCESS: `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(GOOD)})`,
  PLAN_CONTRADICTION: `require('fs').writeFileSync(process.argv[1], ${JSON.stringify(CONTRADICTION)})`,
  EXECUTION_FAILURE: 'process.exit(3)',
  PERMISSION_FAILURE: BLOCKED,
  QUOTA_EXHAUSTED: QUOTA,
  CRASH: 'process.kill(process.pid, "SIGKILL")',
};

for (const [name, script] of Object.entries(SCENARIOS)) {
  test(`the original local config is back byte for byte after a ${name} run, even if nobody reads the status`, async () => {
    const { repo, run } = runWithOriginal(script);
    assert.equal(await untilRestored(repo, run.runDir), true, 'the supervisor restored the config on its own');
    assert.equal(readFileSync(target(repo), 'utf8'), ORIGINAL);
    await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
    assert.equal(readFileSync(target(repo), 'utf8'), ORIGINAL);
  });
}

test('a timeout restores the original local config', async () => {
  const { repo, run } = runWithOriginal('setTimeout(() => {}, 60000)', { wallMs: 800 });
  assert.equal(await untilRestored(repo, run.runDir), true);
  assert.equal(readFileSync(target(repo), 'utf8'), ORIGINAL);
  const st = await waitRun({ repo, runId: run.runId, timeoutMs: 20000 });
  assert.equal(st.classification.status, 'TIMEOUT');
});

test('a run that created the config leaves no .devin directory behind in any outcome', async () => {
  for (const script of Object.values(SCENARIOS)) {
    const repo = gitRepo();
    const planPath = join(repo, '.orchestrator', 'plans', 'p1.md');
    mkdirSync(dirname(planPath), { recursive: true });
    writeFileSync(planPath, '# Plan p1\n\n## Validation\n- Commands: `npm test`\n');
    const run = startRun({
      repo, planPath, klass: 'SMALL_FIX', entry, effort: 'medium', config, resolveExe: () => node,
      buildInvocation: ({ resultPath }) => ({ exeName: 'node', args: ['-e', script, resultPath], stdinPath: null, cwd: repo, permission: 'smart' }),
      projectRules: 'r', baseline: 'b',
    });
    assert.equal(await untilRestored(repo, run.runDir), true);
    assert.equal(existsSync(join(repo, '.devin')), false);
  }
});
