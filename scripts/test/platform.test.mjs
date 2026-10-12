import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { resolveExecutable, stateDir, cleanEnv, isWindows } from '../lib/platform.mjs';

function fakeBin(dir, name) {
  const file = join(dir, isWindows ? `${name}.exe` : name);
  writeFileSync(file, '');
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
