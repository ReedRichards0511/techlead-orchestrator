import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gitPorcelain } from '../lib/git.mjs';
import {
  acquireLock,
  readLock,
  lockStatus,
  releaseLock,
  takeSnapshot,
  ensureExcluded,
  inProgressOperation,
  preflight,
  postflightChecks,
  scanAddedComments,
} from '../lib/safety.mjs';

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.defaults.json'), 'utf8'));

function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false });
  return r.stdout.trim();
}

function makeRepo(files = { 'a.txt': 'hello\n' }) {
  const repo = mkdtempSync(join(tmpdir(), 'orch-safe-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'tester');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

function planText(inScope = 'a.txt') {
  return `# Plan p1\n\n## Scope\n- In scope: ${inScope}\n- Out of scope: the rest\n\n## Validation\n- Commands: \`node -v\`\n`;
}

const write = (repo, p, body) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true });
  writeFileSync(join(repo, p), body);
};

test('acquireLock creates an atomic lock and refuses another plan', () => {
  const repo = makeRepo();
  const lock = acquireLock({ repo, planId: 'p1', runId: 'r1' });
  assert.equal(lock.planId, 'p1');
  assert.ok(existsSync(join(repo, '.orchestrator', 'lock')));
  assert.throws(() => acquireLock({ repo, planId: 'p2' }), /locked/i);
});

test('the same plan can re-acquire and update its lock', () => {
  const repo = makeRepo();
  acquireLock({ repo, planId: 'p1', runId: 'r1' });
  acquireLock({ repo, planId: 'p1', runId: 'r2', pid: process.pid });
  const l = readLock(repo);
  assert.equal(l.runId, 'r2');
  assert.equal(l.pid, process.pid);
});

test('lockStatus tells live holders from dead ones', () => {
  const repo = makeRepo();
  acquireLock({ repo, planId: 'p1', runId: 'r1', pid: process.pid });
  assert.equal(lockStatus(repo).live, true);
  acquireLock({ repo, planId: 'p1', runId: 'r1', pid: 2147483000 });
  const s = lockStatus(repo);
  assert.equal(s.held, true);
  assert.equal(s.live, false);
  assert.equal(lockStatus(makeRepo()).held, false);
});

test('releaseLock only releases the owning plan unless forced', () => {
  const repo = makeRepo();
  acquireLock({ repo, planId: 'p1' });
  assert.throws(() => releaseLock({ repo, planId: 'p2' }), /owned/i);
  releaseLock({ repo, planId: 'p2', force: true });
  assert.equal(readLock(repo), null);
  acquireLock({ repo, planId: 'p1' });
  releaseLock({ repo, planId: 'p1' });
  assert.equal(readLock(repo), null);
});

test('takeSnapshot records head, branch, stash list and manifest hashes', () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'package.json': '{}\n', 'sub/pubspec.lock': 'l\n' });
  const s = takeSnapshot({ repo, planId: 'p1' });
  assert.equal(s.head, git(repo, 'rev-parse', 'HEAD'));
  assert.equal(s.branch, 'main');
  assert.deepEqual(s.stashList, []);
  assert.ok(s.manifests['package.json']);
  assert.ok(s.manifests['sub/pubspec.lock']);
  assert.equal(s.stashHash, null);
});

test('takeSnapshot does not touch the working tree, index or stash list', () => {
  const repo = makeRepo();
  write(repo, 'a.txt', 'changed\n');
  write(repo, 'untracked.txt', 'u\n');
  const before = { status: git(repo, 'status', '--porcelain'), stash: git(repo, 'stash', 'list'), a: readFileSync(join(repo, 'a.txt'), 'utf8') };
  const s = takeSnapshot({ repo, planId: 'p1' });
  assert.ok(s.stashHash, 'dirty tracked changes produce a backup hash');
  assert.equal(git(repo, 'status', '--porcelain'), before.status);
  assert.equal(git(repo, 'stash', 'list'), before.stash);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), before.a);
  assert.deepEqual(s.untracked, ['untracked.txt']);
  assert.ok(s.dirtyHashes['a.txt']);
});

test('snapshots from a monorepo subdirectory hash and back up files using Git root paths', () => {
  const prefix = 'Mobile project/expo-app/';
  const root = makeRepo({ [`${prefix}a.txt`]: 'initial\n', [`${prefix}package.json`]: '{}\n', 'outside.txt': 'initial\n' });
  const repo = join(root, prefix);
  write(repo, 'a.txt', 'my edits\n');
  write(repo, 'scratch.txt', 'my untracked work\n');
  write(root, 'outside.txt', 'outside edits\n');
  write(root, 'outside-new.txt', 'outside untracked work\n');
  const before = git(root, 'status', '--porcelain');
  const s = takeSnapshot({ repo, planId: 'p1' });
  assert.ok(s.dirtyHashes[`${prefix}a.txt`]);
  assert.ok(s.dirtyHashes['outside.txt']);
  assert.ok(s.manifests[`${prefix}package.json`]);
  assert.ok(s.guarded['repo:.git/config']);
  assert.deepEqual(s.untrackedSkipped, []);
  for (const path of [`${prefix}scratch.txt`, 'outside-new.txt']) {
    assert.ok(s.untrackedSaved.includes(path));
    assert.equal(readFileSync(join(repo, '.orchestrator', 'snapshots', 'p1', 'untracked', path), 'utf8'), readFileSync(join(root, path), 'utf8'));
  }
  assert.equal(git(root, 'status', '--porcelain'), before);
  assert.deepEqual(postflightChecks({ repo, snapshot: s, planText: planText('a.txt'), config }).changedFiles, []);
});

test('Git status excludes runner state in a subdirectory with spaces even before preflight', () => {
  const prefix = 'Mobile project/expo-app/';
  const root = makeRepo({ [`${prefix}a.txt`]: 'initial\n' });
  const repo = join(root, prefix);
  write(repo, '.orchestrator/plans/p1.md', 'plan\n');
  assert.equal(gitPorcelain(repo), '');
  write(repo, 'a.txt', 'edited\n');
  assert.equal(gitPorcelain(repo), ` M ${prefix}a.txt`);
});

test('postflight in a monorepo recognizes workspace scope and still detects outside edits', () => {
  const prefix = 'Mobile project/expo-app/';
  const root = makeRepo({ [`${prefix}src/a.js`]: 'const a = 1;\n', [`${prefix}package.json`]: '{}\n', 'outside.txt': 'initial\n' });
  const repo = join(root, prefix);
  const snapshot = takeSnapshot({ repo, planId: 'p1' });
  write(repo, 'src/a.js', 'const a = 2;\n// new comment\n');
  write(repo, 'src/new.js', 'const b = 1;\n');
  write(repo, 'package.json', '{"changed":true}\n');
  const allowed = postflightChecks({ repo, snapshot, planText: planText('src/, package.json'), config });
  assert.equal(allowed.violations.some(v => ['SOFT_SCOPE_VIOLATION', 'MANIFEST_CHANGED'].includes(v.code)), false);
  assert.deepEqual(allowed.comments.map(c => `${c.file}:${c.line}`), [`${prefix}src/a.js:2`]);
  write(root, 'outside.txt', 'worker edit\n');
  const outside = postflightChecks({ repo, snapshot, planText: planText('src/, package.json'), config });
  assert.deepEqual(outside.violations.filter(v => v.code === 'SOFT_SCOPE_VIOLATION').map(v => v.path), ['outside.txt']);
  unlinkSync(join(root, 'outside.txt'));
  assert.ok(postflightChecks({ repo, snapshot, planText: planText('src/, package.json'), config }).violations.some(v => v.code === 'DELETED_OUT_OF_PLAN'));
});

test('postflight refuses to approve an old snapshot with missing hashes for existing files', () => {
  const repo = makeRepo();
  write(repo, 'a.txt', 'my edits\n');
  const snapshot = takeSnapshot({ repo, planId: 'p1' });
  snapshot.dirtyHashes['a.txt'] = null;
  const r = postflightChecks({ repo, snapshot, planText: planText(), config });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some(v => v.code === 'SNAPSHOT_INCOMPLETE'));
});

test('a file already deleted before the snapshot does not make it incomplete', () => {
  const repo = makeRepo();
  unlinkSync(join(repo, 'a.txt'));
  const snapshot = takeSnapshot({ repo, planId: 'p1' });
  assert.equal(snapshot.dirtyHashes['a.txt'], null);
  const r = postflightChecks({ repo, snapshot, planText: planText(), config });
  assert.equal(r.ok, true);
  assert.deepEqual(r.changedFiles, []);
});

test('ensureExcluded adds .orchestrator/ once to .git/info/exclude', () => {
  const repo = makeRepo();
  ensureExcluded(repo);
  ensureExcluded(repo);
  const text = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(text.split('\n').filter((l) => l.trim() === '.orchestrator/').length, 1);
  mkdirSync(join(repo, '.orchestrator'), { recursive: true });
  write(repo, '.orchestrator/x.md', 'x');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('inProgressOperation detects merge, rebase and friends', () => {
  const repo = makeRepo();
  assert.equal(inProgressOperation(repo), null);
  writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'abc');
  assert.equal(inProgressOperation(repo), 'merge');
  unlinkSync(join(repo, '.git', 'MERGE_HEAD'));
  mkdirSync(join(repo, '.git', 'rebase-merge'));
  assert.equal(inProgressOperation(repo), 'rebase');
});

function planFile(repo, text = planText()) {
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  const p = join(repo, '.orchestrator', 'plans', 'p1.md');
  writeFileSync(p, text);
  return p;
}

test('preflight rejects missing or unparseable scope and validation before taking a lock', async () => {
  const plans = ['# Plan', planText().replace('In scope:', 'Files:'), planText().replace('Commands:', 'Tests:')];
  for (const text of plans) {
    const repo = makeRepo();
    const r = await preflight({ repo, planPath: planFile(repo, text), config, skipBaseline: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /plan|scope|validation/i);
    assert.equal(readLock(repo), null);
  }
});

test('postflight cannot approve edits when the plan scope or validation is unparseable', () => {
  for (const text of ['# Plan', planText().replace('Commands:', 'Tests:')]) {
    const repo = makeRepo();
    const snapshot = takeSnapshot({ repo, planId: 'p1' });
    write(repo, 'a.txt', 'updated\n');
    const r = postflightChecks({ repo, snapshot, planText: text, config });
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.code === 'INVALID_PLAN'));
  }
});

test('preflight on a clean repo locks, snapshots and records the baseline', async () => {
  const repo = makeRepo();
  const planPath = planFile(repo);
  const r = await preflight({ repo, planPath, config });
  assert.equal(r.ok, true);
  assert.equal(r.lock.planId, 'p1');
  assert.ok(existsSync(join(repo, '.orchestrator', 'snapshots', 'p1.json')));
  assert.equal(r.snapshot.baseline[0].command, 'node -v');
  assert.equal(r.snapshot.baseline[0].passed, true);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('preflight asks for confirmation when the tree is dirty and does not lock', async () => {
  const repo = makeRepo();
  const planPath = planFile(repo);
  write(repo, 'mine.txt', 'my work\n');
  const r = await preflight({ repo, planPath, config });
  assert.equal(r.ok, false);
  assert.equal(r.needsConfirmation, true);
  assert.deepEqual(r.dirtyFiles, ['mine.txt']);
  assert.equal(readLock(repo), null);
  const accepted = await preflight({ repo, planPath, config, acceptDirty: true });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.snapshot.untracked, ['mine.txt']);
});

test('preflight refuses during a merge or rebase and outside a git repo', async () => {
  const repo = makeRepo();
  const planPath = planFile(repo);
  writeFileSync(join(repo, '.git', 'MERGE_HEAD'), 'abc');
  const r = await preflight({ repo, planPath, config });
  assert.equal(r.ok, false);
  assert.match(r.error, /merge/);
  const plain = mkdtempSync(join(tmpdir(), 'orch-nogit-'));
  const p2 = planFile(plain);
  const r2 = await preflight({ repo: plain, planPath: p2, config });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /git repository/i);
});

test('preflight refuses when another plan holds the lock', async () => {
  const repo = makeRepo();
  const planPath = planFile(repo);
  acquireLock({ repo, planId: 'other' });
  const r = await preflight({ repo, planPath, config });
  assert.equal(r.ok, false);
  assert.match(r.error, /locked/i);
});

test('preflight can skip the baseline', async () => {
  const repo = makeRepo();
  const planPath = planFile(repo);
  const r = await preflight({ repo, planPath, config, skipBaseline: true });
  assert.deepEqual(r.snapshot.baseline, []);
});

async function snap(repo, plan = planText()) {
  planFile(repo, plan);
  return takeSnapshot({ repo, planId: 'p1' });
}

const check = (repo, snapshot, plan = planText()) => postflightChecks({ repo, snapshot, planText: plan, config });
const codes = (r) => r.violations.map((v) => v.code).sort();

test('no changes means no violations', async () => {
  const repo = makeRepo();
  const s = await snap(repo);
  const r = check(repo, s);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.changedFiles, []);
});

test('an in-scope edit is clean; an out-of-scope edit is flagged for audit only', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
  const s = await snap(repo);
  write(repo, 'a.txt', 'x2\n');
  assert.deepEqual(check(repo, s).violations, []);
  write(repo, 'b.txt', 'y2\n');
  const r = check(repo, s);
  assert.deepEqual(codes(r), ['SOFT_SCOPE_VIOLATION']);
  assert.equal(r.violations[0].severity, 'flag');
  assert.equal(r.ok, true);
});

test('a new commit is a grave violation with a recovery command', async () => {
  const repo = makeRepo();
  const s = await snap(repo);
  write(repo, 'a.txt', 'z\n');
  git(repo, 'commit', '-qam', 'sneaky');
  const r = check(repo, s);
  assert.ok(codes(r).includes('HEAD_MOVED'));
  assert.equal(r.ok, false);
  assert.ok(r.violations.find((v) => v.code === 'HEAD_MOVED').severity === 'grave');
  assert.ok(r.recovery.some((c) => c.includes(s.head)));
});

test('switching branch is a grave violation', async () => {
  const repo = makeRepo();
  const s = await snap(repo);
  git(repo, 'switch', '-q', '-c', 'other');
  const r = check(repo, s);
  assert.ok(codes(r).includes('BRANCH_CHANGED'));
  assert.ok(r.recovery.some((c) => c.includes('main')));
});

test('a new stash entry is a grave violation', async () => {
  const repo = makeRepo();
  const s = await snap(repo);
  write(repo, 'a.txt', 'stash me\n');
  git(repo, 'stash', 'push', '-q');
  const r = check(repo, s);
  assert.ok(codes(r).includes('STASH_CHANGED'));
});

test('deleting a file that is not in the plan is grave; deleting an in-scope file is fine', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'b.txt': 'y\n' });
  const s = await snap(repo);
  unlinkSync(join(repo, 'a.txt'));
  assert.deepEqual(check(repo, s).violations, []);
  unlinkSync(join(repo, 'b.txt'));
  const r = check(repo, s);
  assert.ok(codes(r).includes('DELETED_OUT_OF_PLAN'));
  assert.equal(r.violations.find((v) => v.code === 'DELETED_OUT_OF_PLAN').severity, 'grave');
  assert.ok(r.recovery.some((c) => c.includes('b.txt')));
});

test('manifests and lockfiles changed without the plan asking are violations', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'package.json': '{"a":1}\n' });
  const s = await snap(repo);
  write(repo, 'package.json', '{"a":2}\n');
  write(repo, 'package-lock.json', '{}\n');
  const r = check(repo, s);
  const manifest = r.violations.filter((v) => v.code === 'MANIFEST_CHANGED').map((v) => v.path).sort();
  assert.deepEqual(manifest, ['package-lock.json', 'package.json']);
  assert.equal(r.ok, false);
  const allowed = check(repo, s, planText('a.txt, package.json, package-lock.json'));
  assert.equal(allowed.violations.some((v) => v.code === 'MANIFEST_CHANGED'), false);
});

test('only added lines are scanned for new comments', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'src/m.js': '// old comment\nconst a = 1;\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', '// old comment\nconst a = 1;\n// brand new comment\nconst url = "http://example.com/x";\nconst b = 2; // trailing note\n');
  const r = check(repo, s, planText('src/'));
  const found = r.comments.map((c) => `${c.file}:${c.line}`);
  assert.deepEqual(found, ['src/m.js:3', 'src/m.js:5']);
  assert.ok(r.violations.some((v) => v.code === 'NEW_COMMENT' && v.severity === 'flag'));
});

test('removed comments are not flagged', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'src/m.js': '// old comment\nconst a = 1;\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', 'const a = 1;\n');
  assert.deepEqual(check(repo, s, planText('src/')).comments, []);
});

test('updating existing comments does not create a new-comment flag, but an additional comment does', async () => {
  const repo = makeRepo({ 'src/m.js': '// TODO(nav): old route\nconst a = 1;\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', '// TODO(nav): new route\nconst a = 1;\n');
  assert.deepEqual(check(repo, s, planText('src/')).comments, []);
  write(repo, 'src/m.js', '// TODO(nav): new route\nconst a = 1;\n// brand new\n');
  assert.deepEqual(check(repo, s, planText('src/')).comments.map(c => c.line), [3]);
});

test('removing one comment does not hide a new comment in a different diff hunk', async () => {
  const body = '// old comment\n' + Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const repo = makeRepo({ 'src/m.js': body });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', body.replace('// old comment\n', '') + '// unrelated new comment\n');
  assert.equal(check(repo, s, planText('src/')).comments.length, 1);
});

test('comment-like strings are ignored, but actual JSX comments are detected', async () => {
  const repo = makeRepo({ 'src/m.tsx': 'const a = 1;\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.tsx', 'const a = 1;\nconst text = "label // text";\nconst jsx = <View>{/* actual comment */}</View>;\n');
  assert.deepEqual(check(repo, s, planText('src/')).comments.map(c => c.line), [3]);
});

test('indentation accompanying a substantive change is not treated as a formatting-only rewrite', async () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n') + '\n';
  const repo = makeRepo({ 'src/m.js': body });
  const s = await snap(repo, planText('src/'));
  const changed = Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n') + '\n' + Array.from({ length: 40 }, (_, i) => `const newValue${i} = ${i};`).join('\n');
  write(repo, 'src/m.js', changed);
  assert.equal(codes(check(repo, s, planText('src/'))).includes('WHITESPACE_ONLY'), false);
});

test('comments in new untracked files are flagged too', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/new.py', 'x = 1\n# explain x\n"""docstring"""\n');
  const r = check(repo, s, planText('src/'));
  assert.deepEqual(r.comments.map((c) => c.line), [2, 3]);
});

test('TODO and FIXME markers are flagged in any text file', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n' });
  const s = await snap(repo);
  write(repo, 'a.txt', 'x\nTODO fix later\n');
  const r = check(repo, s);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].kind, 'marker');
});

test('markdown and json files are not scanned for comments', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'doc.md': '# t\n', 'c.json': '{}\n' });
  const s = await snap(repo, planText('doc.md, c.json'));
  write(repo, 'doc.md', '# t\n# another heading\n// slashes in prose\n');
  write(repo, 'c.json', '{"u":"http://x"}\n');
  assert.deepEqual(check(repo, s, planText('doc.md, c.json')).comments, []);
});

test('massive whitespace-only rewrites are flagged', async () => {
  const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const repo = makeRepo({ 'a.txt': body });
  const s = await snap(repo);
  write(repo, 'a.txt', Array.from({ length: 80 }, (_, i) => `    line ${i}`).join('\n') + '\n');
  const r = check(repo, s);
  assert.ok(codes(r).includes('WHITESPACE_ONLY'));
});

test('files that were already dirty are only counted when the worker changed them again', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'mine.txt': 'm\n' });
  write(repo, 'mine.txt', 'my edit\n');
  write(repo, 'scratch.txt', 'mine too\n');
  const s = await snap(repo);
  const untouched = check(repo, s);
  assert.deepEqual(untouched.changedFiles, []);
  write(repo, 'mine.txt', 'my edit plus worker\n');
  const touched = check(repo, s);
  assert.deepEqual(touched.changedFiles.map((f) => f.path), ['mine.txt']);
  assert.ok(codes(touched).includes('SOFT_SCOPE_VIOLATION'));
});

test('an unparsable scope is reported instead of silently passing', async () => {
  const repo = makeRepo();
  const s = await snap(repo, '# plan without a scope section\n');
  write(repo, 'a.txt', 'z\n');
  const r = check(repo, s, '# plan without a scope section\n');
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'INVALID_PLAN' && /scope/i.test(v.detail)));
});

test('scanAddedComments classifies comment styles by extension', () => {
  const found = scanAddedComments([
    { file: 'x.ts', added: [{ line: 1, text: '/** doc */' }, { line: 2, text: ' * more' }, { line: 3, text: 'const a = `//not`;' }] },
    { file: 'y.sh', added: [{ line: 1, text: '#!/bin/sh' }, { line: 2, text: '# note' }] },
    { file: 'z.html', added: [{ line: 1, text: '<!-- hi -->' }] },
    { file: 'q.sql', added: [{ line: 1, text: '-- hi' }] },
  ]);
  assert.deepEqual(found.map((f) => `${f.file}:${f.line}`), ['x.ts:1', 'x.ts:2', 'y.sh:2', 'z.html:1', 'q.sql:1']);
});

test('an added line that references .orchestrator is a violation and names the file', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'src/m.js': 'const a = 1;\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', "const a = 1;\nconst data = readFileSync('.orchestrator/assets/x.json');\n");
  write(repo, 'src/n.test.js', "import x from '../.orchestrator/plans/p.md';\n");
  const r = check(repo, s, planText('src/'));
  const v = r.violations.find((x) => x.code === 'ORCHESTRATOR_REFERENCE');
  assert.ok(v);
  assert.equal(v.severity, 'violation');
  assert.match(v.detail, /src\/m\.js/);
  assert.match(v.detail, /src\/n\.test\.js/);
  assert.doesNotMatch(v.detail, /readFileSync|assets/);
  assert.equal(r.ok, false);
});

test('a pre-existing reference or a removed one is not flagged', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', 'src/m.js': "const p = '.orchestrator/old';\nconst a = 1;\n" });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', "const p = '.orchestrator/old';\nconst a = 2;\n");
  assert.equal(check(repo, s, planText('src/')).violations.some((v) => v.code === 'ORCHESTRATOR_REFERENCE'), false);
  write(repo, 'src/m.js', 'const a = 3;\n');
  assert.equal(check(repo, s, planText('src/')).violations.some((v) => v.code === 'ORCHESTRATOR_REFERENCE'), false);
});

test('mentions of .orchestrator in .gitignore are allowed but in docs and json are not', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n', '.gitignore': 'node_modules\n' });
  const s = await snap(repo, planText('.gitignore, docs/, cfg.json'));
  write(repo, '.gitignore', 'node_modules\n.orchestrator/\n');
  assert.equal(check(repo, s, planText('.gitignore, docs/, cfg.json')).violations.some((v) => v.code === 'ORCHESTRATOR_REFERENCE'), false);
  write(repo, 'cfg.json', '{"path":".orchestrator/x"}\n');
  const r = check(repo, s, planText('.gitignore, docs/, cfg.json'));
  assert.ok(r.violations.some((v) => v.code === 'ORCHESTRATOR_REFERENCE' && /cfg\.json/.test(v.detail)));
});

test('a word that merely contains orchestrator is not flagged', async () => {
  const repo = makeRepo({ 'a.txt': 'x\n' });
  const s = await snap(repo, planText('src/'));
  write(repo, 'src/m.js', 'const orchestrator = 1;\nconst m = "my.orchestrators";\n');
  assert.equal(check(repo, s, planText('src/')).violations.some((v) => v.code === 'ORCHESTRATOR_REFERENCE'), false);
});
