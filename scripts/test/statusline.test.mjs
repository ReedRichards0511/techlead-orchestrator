import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractUsage, renderLine } from '../lib/statusline.mjs';
import { readClaudeUsage } from '../lib/quota/claude.mjs';
import { loadConfig } from '../lib/config.mjs';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'statusline.mjs');
const NOW = new Date('2026-10-12T15:00:00Z');
const reset5 = Math.floor(NOW.getTime() / 1000) + 3 * 3600;
const reset7 = Math.floor(NOW.getTime() / 1000) + 4 * 86400;

const full = () => ({
  session_id: 'secret-session',
  transcript_path: 'C:\\Users\\someone\\.claude\\projects\\x.jsonl',
  cwd: 'C:\\Users\\someone\\repo',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  rate_limits: { five_hour: { used_percentage: 52, resets_at: reset5 }, seven_day: { used_percentage: 71, resets_at: reset7 } },
});

function run(input, { args = [], state = mkdtempSync(join(tmpdir(), 'orch-sl-')) } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, ORCH_STATE_DIR: state },
    timeout: 30000,
  });
  return { ...r, state, file: join(state, 'claude-usage.json') };
}

test('extractUsage keeps only the two windows and drops everything else', () => {
  const u = extractUsage(full());
  assert.deepEqual(u, { five_hour: { used_percentage: 52, resets_at: reset5 }, seven_day: { used_percentage: 71, resets_at: reset7 } });
});

test('extractUsage ignores invalid windows and returns null without any valid one', () => {
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage({ rate_limits: {} }), null);
  assert.equal(extractUsage({ rate_limits: { five_hour: { used_percentage: 'x', resets_at: 1 } } }), null);
  assert.equal(extractUsage({ rate_limits: { five_hour: { used_percentage: 120, resets_at: 1 } } }), null);
  assert.equal(extractUsage({ rate_limits: { five_hour: { used_percentage: -1, resets_at: 1 } } }), null);
  assert.deepEqual(extractUsage({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 5 }, seven_day: { used_percentage: 'bad' } } }), {
    five_hour: { used_percentage: 10, resets_at: 5 },
  });
});

test('renderLine shows remaining percent and is empty without data', () => {
  assert.equal(renderLine(null), '');
  const line = renderLine(extractUsage(full()), NOW);
  assert.match(line, /5h 48%/);
  assert.match(line, /7d 29%/);
});

test('the script writes claude-usage.json with writtenAt and only whitelisted fields', () => {
  const r = run(full());
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.deepEqual(Object.keys(data).sort(), ['rate_limits', 'writtenAt']);
  assert.ok(!Number.isNaN(new Date(data.writtenAt).getTime()));
  assert.equal(data.rate_limits.five_hour.used_percentage, 52);
  const raw = readFileSync(r.file, 'utf8');
  assert.doesNotMatch(raw, /secret-session|someone|transcript|Opus/);
});

test('the file written is readable by the Claude quota provider', () => {
  const r = run(full());
  const config = loadConfig({ stateDir: r.state });
  const q = readClaudeUsage({ file: r.file, now: new Date(), config });
  assert.equal(q.source, 'statusline');
  assert.equal(q.windows.short.remainingPercent, 48);
  assert.equal(q.windows.weekly.remainingPercent, 29);
});

test('a render without rate_limits does not overwrite previous data', () => {
  const first = run(full());
  const before = readFileSync(first.file, 'utf8');
  const second = run({ session_id: 'x', model: { display_name: 'Opus' } }, { state: first.state });
  assert.equal(second.status, 0);
  assert.equal(readFileSync(first.file, 'utf8'), before);
});

test('no file is created when the very first render has no rate_limits', () => {
  const r = run({ session_id: 'x' });
  assert.equal(r.status, 0);
  assert.equal(existsSync(r.file), false);
});

test('garbage or empty stdin never fails and prints nothing sensitive', () => {
  for (const input of ['', 'not json', '{"rate_limits":']) {
    const r = run(input);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(r.file), false);
  }
});

test('default output is the short usage line', () => {
  const r = run(full());
  assert.match(r.stdout.trim(), /5h 48%/);
});

test('wrap mode runs the existing statusline with the same stdin and prints its output', () => {
  const fake = join(mkdtempSync(join(tmpdir(), 'orch-slw-')), 'fake.mjs');
  writeFileSync(fake, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write('WRAPPED '+j.model.display_name)})");
  const r = run(full(), { args: ['--', process.execPath, fake] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'WRAPPED Opus 5.5');
  assert.equal(JSON.parse(readFileSync(r.file, 'utf8')).rate_limits.seven_day.used_percentage, 71);
});

test('wrap mode still writes the file when the wrapped command is missing or fails', () => {
  const r = run(full(), { args: ['--', 'definitely-not-a-real-command-xyz'] });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(r.file));
});
