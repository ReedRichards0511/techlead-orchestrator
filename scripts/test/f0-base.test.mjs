import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const orch = join(root, 'scripts', 'orch.mjs');

test('orch --help lists every subcommand from the plan', () => {
  const r = spawnSync(process.execPath, [orch, '--help'], { encoding: 'utf8', shell: false });
  assert.equal(r.status, 0);
  for (const cmd of ['doctor', 'models', 'quota', 'route', 'preflight', 'run', 'status', 'wait', 'postflight', 'history', 'bootstrap', 'unlock']) {
    assert.match(r.stdout, new RegExp(`\\b${cmd}\\b`), `missing ${cmd}`);
  }
});

test('orch with unknown subcommand exits non-zero', () => {
  const r = spawnSync(process.execPath, [orch, 'nope'], { encoding: 'utf8', shell: false });
  assert.notEqual(r.status, 0);
});

test('directory layout from the plan exists', () => {
  for (const p of ['SKILL.md', 'config.defaults.json', 'references', 'scripts/lib', 'scripts/lib/quota', 'scripts/lib/adapters', 'scripts/test']) {
    assert.ok(existsSync(join(root, p)), `missing ${p}`);
  }
});

test('config.defaults.json matches plan section 12.2', () => {
  const c = JSON.parse(readFileSync(join(root, 'config.defaults.json'), 'utf8'));
  assert.equal(c.version, 1);
  assert.deepEqual(c.reserves, { claude: 35, codex: 20, devin: 0, antigravity: 10 });
  assert.equal(c.repairMaxCycles, 2);
  assert.equal(c.bootstrap.runsPerClass, 10);
  assert.deepEqual(c.bootstrap.classes, ['REFACTOR', 'MIGRATION', 'FEATURE']);
  assert.equal(c.permissions.devin.default, 'smart');
  assert.equal(c.permissions.devin.retryOnBlock, 'dangerous');
  assert.equal(c.neverUseCodexResetCredits, true);
  assert.ok(c.forbiddenCommands.includes('git commit'));
  assert.equal(c.timeouts.SMALL_FIX, 20);
});
