import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFileOperations, parseFileOperations, prepareFileOperations, fileOperationCommands, applyFileOperation } from '../lib/file-operations.mjs';
import { assessBlockedCalls } from '../lib/permissions.mjs';
import { preflight } from '../lib/safety.mjs';
import { spawnSync } from 'node:child_process';

function setup(kind = 'move') {
  const repo = mkdtempSync(join(tmpdir(), 'orch-files-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'old.ts'), 'original content\n');
  const planText = `## Scope\n- In scope: src/old.ts, src/new.ts\n## Validation\n- Commands: \`node -v\`\n## File operations\n- ${kind === 'move' ? 'Move: `src/old.ts` -> `src/new.ts`' : 'Delete: `src/old.ts`'}\n`;
  const planPath = join(repo, '.orchestrator', 'plans', 'p1.md');
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  writeFileSync(planPath, planText);
  const operations = checkFileOperations({ repo, planText });
  prepareFileOperations({ repo, planId: 'p1', operations });
  mkdirSync(join(repo, '.orchestrator', 'runs', 'p1-run'), { recursive: true });
  writeFileSync(join(repo, '.orchestrator', 'runs', 'p1-run', 'status.json'), JSON.stringify({ state: 'running', meta: { planId: 'p1', planPath } }));
  writeFileSync(join(repo, '.orchestrator', 'lock'), JSON.stringify({ runId: 'p1-run', planId: 'p1' }));
  return { repo, planText, planPath, runId: 'p1-run', operation: 1 };
}

test('declared move preserves bytes, leaves a backup and is idempotent for continuation', () => {
  const opts = setup();
  applyFileOperation(opts);
  assert.equal(existsSync(join(opts.repo, 'src', 'old.ts')), false);
  assert.equal(readFileSync(join(opts.repo, 'src', 'new.ts'), 'utf8'), 'original content\n');
  assert.equal(readFileSync(join(opts.repo, '.orchestrator', 'snapshots', 'p1', 'file-operation-1.backup'), 'utf8'), 'original content\n');
  assert.equal(applyFileOperation(opts).alreadyApplied, true);
});

test('declared deletion preserves a preflight backup and refuses an inactive writer', () => {
  const opts = setup('delete');
  assert.throws(() => applyFileOperation({ ...opts, runId: 'other' }), /active worker/);
  applyFileOperation(opts);
  assert.equal(existsSync(join(opts.repo, 'src', 'old.ts')), false);
  assert.equal(existsSync(join(opts.repo, '.orchestrator', 'snapshots', 'p1', 'file-operation-1.backup')), true);
});

test('file operations refuse overwrites, outside scope, traversal, directories and protected paths', () => {
  const opts = setup();
  writeFileSync(join(opts.repo, 'src', 'new.ts'), 'keep this');
  assert.throws(() => applyFileOperation(opts), /overwrite/);
  assert.equal(readFileSync(join(opts.repo, 'src', 'new.ts'), 'utf8'), 'keep this');
  for (const path of ['../outside', '.git/config', '.orchestrator/lock', '/etc/passwd', 'C:\\outside', 'src']) {
    const text = `## Scope\n- In scope: src/\n## File operations\n- Delete: \`${path}\`\n`;
    assert.throws(() => checkFileOperations({ repo: opts.repo, planText: text }), /relative|Unsafe|outside|regular/);
  }
  assert.throws(() => checkFileOperations({ repo: opts.repo, planText: opts.planText.replace('src/old.ts, src/new.ts', 'src/new.ts') }), /outside.*scope/);
});

test('source symlinks are rejected even when their target is inside scope', { skip: process.platform === 'win32' }, () => {
  const opts = setup();
  symlinkSync(join(opts.repo, 'src', 'old.ts'), join(opts.repo, 'src', 'link.ts'));
  const text = '## Scope\n- In scope: src/\n## File operations\n- Delete: `src/link.ts`\n';
  assert.throws(() => checkFileOperations({ repo: opts.repo, planText: text }), /symlink/);
});

test('exact helper commands can be authorized without allowing arbitrary node, Git or deletion', () => {
  const opts = setup();
  const commands = fileOperationCommands({ ...opts, planId: 'p1' });
  const assess = command => assessBlockedCalls({ calls: [{ tool: 'exec', command }], repo: opts.repo, planText: opts.planText, allowedFileCommands: commands });
  assert.equal(assess(commands[0]).safe, true);
  for (const command of [`${commands[0]} && rm src/new.ts`, 'git mv src/old.ts src/new.ts', 'rm src/old.ts', 'node -e "require(\'fs\').unlinkSync(\'src/old.ts\')"']) assert.equal(assess(command).safe, false);
  assert.throws(() => fileOperationCommands({ ...opts, planId: 'other' }), /preflight backup/);
});

test('changing an operation after preflight is rejected, and malformed entries cannot silently disappear', () => {
  const opts = setup();
  writeFileSync(opts.planPath, opts.planText.replace('-> `src/new.ts`', '-> `src/else.ts`'));
  assert.throws(() => applyFileOperation(opts), /changed after/);
  assert.throws(() => parseFileOperations('## File operations\n- rm src/old.ts\n'), /Invalid/);
});

test('shrinking scope after preflight cannot authorize a previously declared deletion', () => {
  const opts = setup('delete');
  writeFileSync(opts.planPath, opts.planText.replace('src/old.ts, src/new.ts', 'src/new.ts'));
  assert.throws(() => applyFileOperation(opts), /current plan scope/);
  assert.equal(existsSync(join(opts.repo, 'src', 'old.ts')), true);
});

test('an explicit Out of scope entry takes precedence over a broad In scope directory', () => {
  const opts = setup('delete');
  const planText = opts.planText.replace('src/old.ts, src/new.ts', 'src/\n- Out of scope: src/old.ts');
  assert.throws(() => checkFileOperations({ repo: opts.repo, planText }), /outside.*scope/);
});

test('a repeated preflight preserves the original file-operation backup', async () => {
  const opts = setup();
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'test'], ['add', 'src'], ['commit', '-qm', 'baseline']]) assert.equal(spawnSync('git', args, { cwd: opts.repo }).status, 0);
  const config = JSON.parse(readFileSync(new URL('../../config.defaults.json', import.meta.url), 'utf8'));
  const result = await preflight({ repo: opts.repo, planPath: opts.planPath, config, acceptDirty: true, skipBaseline: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /already has file-operation backups/);
  assert.equal(readFileSync(join(opts.repo, '.orchestrator', 'snapshots', 'p1', 'file-operation-1.backup'), 'utf8'), 'original content\n');
});
