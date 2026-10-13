import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, VERIFIED_VERSIONS } from '../lib/doctor.mjs';
import { loadConfig } from '../lib/config.mjs';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PATHS = { claude: 'C:/bin/claude.exe', devin: 'C:/bin/devin.exe', codex: 'C:/bin/codex.exe', agy: 'C:/bin/agy.exe' };

function fakeRun(overrides = {}) {
  return async (exe, args) => {
    const key = `${exe.split('/').pop().replace('.exe', '')} ${args.join(' ')}`;
    if (key in overrides) return overrides[key];
    const table = {
      'claude --version': { status: 0, stdout: '2.1.296 (Claude Code)\n', stderr: '' },
      'devin --version': { status: 0, stdout: 'devin 3000.11.3 (9c803229faa4)\n', stderr: '' },
      'codex --version': { status: 0, stdout: 'codex-cli 0.160.0\n', stderr: '' },
      'agy --version': { status: 0, stdout: '1.3.3\n', stderr: '' },
      'claude auth status': { status: 0, stdout: '{"loggedIn":true,"email":"secret@example.com","orgId":"org-123"}', stderr: '' },
      'devin auth status': { status: 0, stdout: 'Logged in (via Devin).\nEmail: secret@example.com', stderr: '' },
      'codex login status': { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' },
      'git --version': { status: 0, stdout: 'git version 2.55.0.windows.3\n', stderr: '' },
    };
    return table[key] ?? { status: 1, stdout: '', stderr: 'unexpected: ' + key };
  };
}

const base = (extra = {}) => ({
  run: fakeRun(extra.run),
  paths: extra.paths ?? PATHS,
  env: extra.env ?? {},
  catalog: extra.catalog ?? null,
  now: new Date('2026-10-12T12:00:00Z'),
});

test('doctor reports every CLI with path, version and auth', async () => {
  const r = await runDoctor(base());
  assert.equal(r.ok, true);
  for (const name of ['claude', 'devin', 'codex', 'agy']) {
    assert.equal(r.clis[name].found, true, name);
    assert.ok(r.clis[name].version, name);
  }
  assert.equal(r.clis.devin.version, '3000.11.3');
  assert.equal(r.clis.codex.version, '0.160.0');
  assert.equal(r.clis.claude.auth, 'ok');
  assert.equal(r.clis.devin.auth, 'ok');
  assert.equal(r.clis.codex.auth, 'ok');
  assert.equal(r.clis.agy.auth, 'unverified');
});

test('doctor never leaks emails or account ids', async () => {
  const r = await runDoctor(base());
  const text = JSON.stringify(r);
  assert.equal(text.includes('secret@example.com'), false);
  assert.equal(text.includes('org-123'), false);
});

test('doctor stops before implementation when Claude cannot enforce failure-blocking role hooks', async () => {
  const r = await runDoctor(base({ run: { 'claude --version': { status: 0, stdout: '2.1.292 (Claude Code)' } } }));
  assert.equal(r.ok, false);
  assert.equal(r.roleGuard.available, false);
  assert.ok(r.warnings.some(w => w.includes('2.1.295')));
});

test('a missing CLI is reported and does not abort the others', async () => {
  const r = await runDoctor(base({ paths: { ...PATHS, agy: null } }));
  assert.equal(r.clis.agy.found, false);
  assert.equal(r.clis.devin.found, true);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /agy/.test(w)));
});

test('failed auth marks the worker as unusable', async () => {
  const r = await runDoctor(base({ run: { 'codex login status': { status: 1, stdout: '', stderr: 'not logged in' } } }));
  assert.equal(r.clis.codex.auth, 'failed');
  assert.equal(r.workers.codex, false);
  assert.equal(r.workers.devin, true);
});

test('Claude auth status exit zero with loggedIn=false is not an authenticated architect', async () => {
  const r = await runDoctor(base({ run: { 'claude auth status': { status: 0, stdout: '{"loggedIn":false}', stderr: '' } } }));
  assert.equal(r.clis.claude.auth, 'failed');
  assert.equal(r.ok, false);
});

test('version drift from the verified one is a warning, not a failure', async () => {
  const r = await runDoctor(base({ run: { 'codex --version': { status: 0, stdout: 'codex-cli 0.161.0\n', stderr: '' } } }));
  assert.equal(r.clis.codex.version, '0.161.0');
  assert.ok(r.warnings.some((w) => /codex/.test(w) && w.includes(VERIFIED_VERSIONS.codex)));
  assert.equal(r.workers.codex, true);
});

test('cloud sessions abort because workers cannot be launched', async () => {
  const r = await runDoctor(base({ env: { CLAUDE_CODE_REMOTE: 'true' } }));
  assert.equal(r.session.kind, 'cloud');
  assert.equal(r.ok, false);
});

test('catalog age is reported and missing catalog is flagged', async () => {
  const none = await runDoctor(base());
  assert.equal(none.catalog.present, false);
  const old = await runDoctor(base({ catalog: { generatedAt: '2026-10-10T12:00:00Z', models: [{}, {}] } }));
  assert.equal(old.catalog.present, true);
  assert.equal(old.catalog.ageDays, 2);
  assert.equal(old.catalog.models, 2);
});

test('doctor lists the pending checks from the plan', async () => {
  const r = await runDoctor(base());
  assert.deepEqual(r.pending.map((p) => p.id), ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
});

test('loadConfig copies defaults on first run and merges user overrides afterwards', () => {
  const state = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  const cfg = loadConfig({ stateDir: state });
  assert.equal(cfg.reserves.codex, 20);
  assert.ok(existsSync(join(state, 'config.json')));
  const user = JSON.parse(readFileSync(join(state, 'config.json'), 'utf8'));
  user.reserves.codex = 5;
  writeFileSync(join(state, 'config.json'), JSON.stringify(user));
  const again = loadConfig({ stateDir: state });
  assert.equal(again.reserves.codex, 5);
  assert.equal(again.reserves.claude, 35);
});

test('loadConfig rejects an invalid config instead of silently using it', () => {
  const state = mkdtempSync(join(tmpdir(), 'orch-cfg-'));
  writeFileSync(join(state, 'config.json'), '{ not json');
  assert.throws(() => loadConfig({ stateDir: state }), /config\.json/);
});
