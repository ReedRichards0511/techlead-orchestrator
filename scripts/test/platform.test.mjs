import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveExecutable, stateDir, cleanEnv, isWindows } from '../lib/platform.mjs';

function fakeBin(dir, name) {
  const file = join(dir, isWindows ? `${name}.exe` : name);
  writeFileSync(file, '');
  if (!isWindows) chmodSync(file, 0o755);
  return file;
}

test('resolveExecutable finds a binary on PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plat-'));
  const bin = fakeBin(dir, 'fakecli');
  const found = resolveExecutable('fakecli', { env: { PATH: dir } });
  assert.equal(realpathSync(found), realpathSync(bin));
});

test('resolveExecutable prefers config override over PATH', () => {
  const a = mkdtempSync(join(tmpdir(), 'orch-plat-a-'));
  const b = mkdtempSync(join(tmpdir(), 'orch-plat-b-'));
  fakeBin(a, 'fakecli');
  const override = fakeBin(b, 'fakecli');
  const found = resolveExecutable('fakecli', { env: { PATH: a }, overrides: { fakecli: override } });
  assert.equal(realpathSync(found), realpathSync(override));
});

test('resolveExecutable returns null when missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plat-'));
  assert.equal(resolveExecutable('nope-not-here', { env: { PATH: dir } }), null);
});

test('POSIX resolution skips non-executable files and finds a later executable even with spaces', { skip: isWindows }, () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-path-'));
  const first = join(root, 'not executable');
  const second = join(root, 'working bin');
  mkdirSync(first);
  mkdirSync(second);
  const invalid = fakeBin(first, 'fakecli');
  chmodSync(invalid, 0o644);
  const valid = fakeBin(second, 'fakecli');
  assert.equal(resolveExecutable('fakecli', { env: { PATH: [first, second].join(delimiter) }, overrides: { fakecli: invalid } }), valid);
});

test('POSIX resolution finds ~/.local/bin when the app has a restricted PATH', { skip: isWindows }, () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  const bin = join(home, '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const exe = fakeBin(bin, 'fakecli');
  assert.equal(resolveExecutable('fakecli', { env: { HOME: home, PATH: '/usr/bin:/bin' } }), exe);
});

test('resolveExecutable ignores a missing override path and falls back to PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plat-'));
  const bin = fakeBin(dir, 'fakecli');
  const found = resolveExecutable('fakecli', { env: { PATH: dir }, overrides: { fakecli: join(dir, 'ghost') } });
  assert.equal(realpathSync(found), realpathSync(bin));
});

test('resolveExecutable skips .cmd shims and never returns them', { skip: !isWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plat-'));
  writeFileSync(join(dir, 'shim.cmd'), '@echo off');
  assert.equal(resolveExecutable('shim', { env: { PATH: dir, PATHEXT: '.CMD;.EXE' } }), null);
});

test('stateDir lives under the home directory', () => {
  const d = stateDir({ home: join(tmpdir(), 'fakehome') });
  assert.equal(d, join(tmpdir(), 'fakehome', '.claude', 'orchestrator'));
});

test('cleanEnv strips CLAUDE* variables and keeps the rest', () => {
  const env = cleanEnv({ PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', claude_lower: 'k', HOME: 'h' });
  assert.equal(env.PATH, 'x');
  assert.equal(env.HOME, 'h');
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(env.claude_lower, 'k');
});

test('resolves the four real CLIs on this machine', { skip: !isWindows }, () => {
  for (const name of ['claude', 'devin', 'codex', 'agy']) {
    const found = resolveExecutable(name);
    assert.ok(found, `${name} not resolved`);
    assert.ok(existsSync(found), `${name} path does not exist: ${found}`);
    assert.match(found.toLowerCase(), /\.exe$/, `${name} is not a real .exe: ${found}`);
  }
});

test('PATH delimiter is handled for multiple directories', () => {
  const a = mkdtempSync(join(tmpdir(), 'orch-plat-a-'));
  const b = mkdtempSync(join(tmpdir(), 'orch-plat-b-'));
  const bin = fakeBin(b, 'fakecli');
  const found = resolveExecutable('fakecli', { env: { PATH: [a, b].join(delimiter) } });
  assert.equal(realpathSync(found), realpathSync(bin));
});
