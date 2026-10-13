import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeUsage, findTranscript, startUsage, reportUsage, formatUsage } from '../lib/usage.mjs';
import { parseOutput } from '../lib/adapters/index.mjs';

const NOW = new Date('2026-10-13T10:00:00Z');
const AFTER = '2026-10-13T10:01:00Z';
const jsonl = events => events.map(e => JSON.stringify(e)).join('\n') + '\n';
const prompt = id => ({ type: 'user', uuid: id, message: { content: 'private prompt' } });
const assistant = (id, output = 5, extra = {}) => ({ type: 'assistant', requestId: `request-${id}`, message: {
  id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'private output' }],
  usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 70, output_tokens: output },
}, ...extra });

function setup(log = [prompt('old'), assistant('old'), prompt('task'), assistant('first')]) {
  const repo = mkdtempSync(join(tmpdir(), 'orch-usage-'));
  const transcript = join(repo, 'transcript.jsonl');
  writeFileSync(transcript, jsonl(log));
  startUsage({ repo, task: 'task', session: 'session1', transcript, now: NOW });
  return { repo, transcript, task: 'task', session: 'session1' };
}

function worker(opts, id, harness, usage, extra = {}) {
  const dir = join(opts.repo, '.orchestrator', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'exited', startedAt: AFTER, meta: {
    planPath: join(opts.repo, '.orchestrator', 'plans', 'task.md'), harness,
    model: harness === 'devin' ? 'devin/swe-2' : harness === 'codex' ? 'codex/gpt-6.1-sol' : 'agy/gemini-3.8-flash', effort: 'medium',
  }, ...extra }));
  if (harness === 'devin') writeFileSync(join(dir, 'devin-session.json'), JSON.stringify({ final_metrics: usage }));
  else writeFileSync(join(dir, 'stdout.log'), jsonl([harness === 'codex' ? { type: 'turn.completed', usage } : { event: 'result', result: { status: 'SUCCESS', usage } }]));
}

test('normalization counts cache once, reasoning inside output, and rejects invented or unsafe counters', () => {
  assert.equal(normalizeUsage('claude', assistant('x').message.usage).totalTokens, 105);
  assert.equal(normalizeUsage('codex', { input_tokens: 100, cached_input_tokens: 70, output_tokens: 15, reasoning_output_tokens: 10 }).totalTokens, 115);
  assert.equal(normalizeUsage('devin', { source: 'devin-export', promptTokens: 100, cachedTokens: 70, completionTokens: 15 }).totalTokens, 115);
  assert.equal(normalizeUsage('agy', { total_tokens: 123 }).totalTokens, 123);
  assert.equal(normalizeUsage('agy', { total_tokens: 0 }).totalTokens, 0);
  assert.equal(normalizeUsage('codex', { input_tokens: '100', output_tokens: -1 }), null);
  assert.equal(normalizeUsage('codex', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 }).totalTokens, undefined);
  assert.equal(normalizeUsage('devin', { promptTokens: 100, account: 'private' }), null);
});

test('architect accounting excludes previous tasks and duplicate streaming blocks, including the call before start', () => {
  const opts = setup([prompt('old'), assistant('old'), prompt('task'), assistant('first'), assistant('first', 8)]);
  appendFileSync(opts.transcript, jsonl([assistant('first', 7, { requestId: undefined }), assistant('second'), assistant('side', 5, { isSidechain: true }), { type: 'user', message: { content: [{ type: 'tool_result' }] } }, assistant('third')]));
  const report = reportUsage(opts);
  assert.equal(report.actors.length, 1);
  assert.equal(report.actors[0].label, 'Opus 5.5');
  assert.equal(report.totalTokens, 318);
  assert.equal(report.actors[0].usage.cachedTokens, 210);
  assert.equal(report.complete, true);
  const stored = readFileSync(join(opts.repo, '.orchestrator', 'usage', 'task.json'), 'utf8');
  assert.ok(!stored.includes('private prompt') && !stored.includes('private output'));
  appendFileSync(opts.transcript, jsonl([prompt('next-task'), assistant('later', 9999)]));
  assert.equal(reportUsage(opts).totalTokens, report.totalTokens);
});

test('subagents of the same session count in their own row, without older subagents', () => {
  const opts = setup();
  const dir = join(opts.repo, 'session1', 'subagents');
  mkdirSync(dir, { recursive: true });
  const haiku = (id, timestamp) => ({ ...assistant(id), isSidechain: true, timestamp, message: { ...assistant(id).message, model: 'claude-haiku-5-5' } });
  writeFileSync(join(dir, 'agent-figma.jsonl'), jsonl([haiku('before', '2026-10-13T09:00:00Z'), haiku('figma', AFTER), haiku('figma', AFTER)]));
  writeFileSync(join(dir, 'agent-audit.jsonl'), jsonl([{ ...assistant('audit'), isSidechain: true, timestamp: AFTER }]));
  const report = reportUsage(opts);
  assert.deepEqual(report.actors.map(a => [a.label, a.usage.totalTokens]).sort(), [['Haiku 5.5 (subagentes)', 105], ['Opus 5.5 (subagentes)', 105], ['Opus 5.5', 105]]);
  assert.equal(report.totalTokens, 315);
  assert.equal(report.complete, true);
});

test('task report sums retries, repairs and multiple workers, without importing other plans or old runs', () => {
  const opts = setup();
  worker(opts, 'first', 'devin', { total_prompt_tokens: 100, total_cached_tokens: 80, total_completion_tokens: 10 });
  worker(opts, 'repair', 'devin', { total_prompt_tokens: 50, total_cached_tokens: 30, total_completion_tokens: 5 });
  worker(opts, 'codex', 'codex', { input_tokens: 200, cached_input_tokens: 190, output_tokens: 20 });
  worker(opts, 'agy', 'agy', { total_tokens: 70 });
  worker(opts, 'old', 'devin', { total_prompt_tokens: 9999 }, { startedAt: '2026-10-12T00:00:00Z' });
  worker(opts, 'unrelated', 'agy', { total_tokens: 9999 }, { meta: { planPath: join(opts.repo, 'other.md'), harness: 'agy' } });
  const report = reportUsage(opts);
  assert.equal(report.totalTokens, 560);
  assert.equal(report.complete, true);
  assert.equal(report.actors.length, 4);
  const devin = report.actors.find(a => a.label.startsWith('Devin'));
  assert.equal(devin.runs, 2);
  assert.equal(devin.usage.totalTokens, 165);
  const text = formatUsage(report);
  assert.match(text, /SWE-2.*165 tokens/);
  assert.match(text, /Total medido: 560 tokens/);
  assert.ok(!text.includes('$'));
});

test('missing metrics, running workers and a changed session make the total explicitly partial', () => {
  const opts = setup();
  worker(opts, 'missing', 'devin', {});
  worker(opts, 'running', 'agy', { total_tokens: 20 }, { state: 'running' });
  const report = reportUsage({ ...opts, session: 'new-session' });
  assert.equal(report.complete, false);
  assert.equal(report.totalTokens, 125);
  assert.match(formatUsage(report), /Devin.*no disponible/);
  assert.match(formatUsage(report), /Total medido: 125 tokens \(parcial\)/);
});

test('missing or pruned architect transcript never becomes zero', () => {
  const opts = setup();
  writeFileSync(opts.transcript, jsonl([prompt('different'), assistant('different')]));
  const report = reportUsage(opts);
  assert.equal(report.complete, false);
  assert.equal(report.totalTokens, null);
  assert.match(formatUsage(report), /Opus: no disponible/);
});

test('unreadable task records and truncated transcript entries prevent a complete total', () => {
  const opts = setup();
  const dir = join(opts.repo, '.orchestrator', 'runs', 'task-broken');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'status.json'), '{');
  appendFileSync(opts.transcript, '{"type":"assistant"');
  const report = reportUsage(opts);
  assert.equal(report.totalTokens, 105);
  assert.equal(report.complete, false);
  assert.match(formatUsage(report), /Worker.*no disponible/);
});

test('baseline is preserved across resumed calls and task ids cannot escape their directory', () => {
  const opts = setup();
  appendFileSync(opts.transcript, jsonl([prompt('choice'), assistant('after-choice')]));
  assert.equal(startUsage({ ...opts, now: new Date(AFTER) }).resumed, true);
  assert.equal(reportUsage(opts).totalTokens, 210);
  assert.throws(() => startUsage({ ...opts, task: '../escape' }), /task id/);
  assert.throws(() => reportUsage({ ...opts, task: 'absent' }), /baseline/);
});

test('an unfamiliar user payload does not replace the human prompt or break accounting', () => {
  const opts = setup([prompt('task'), assistant('first'), { type: 'user', uuid: 'unknown', message: { content: { unexpected: true } } }]);
  assert.equal(reportUsage(opts).totalTokens, 105);
});

test('a closed task id cannot be reused for new work with stale metrics or a disabled role guard', () => {
  const opts = setup();
  reportUsage(opts);
  assert.throws(() => startUsage(opts), /already closed.*new id/);
});

test('transcript discovery uses the current session in a platform-independent Claude config directory', () => {
  const config = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  const dir = join(config, 'projects', 'project-with-spaces');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'current-session.jsonl');
  writeFileSync(file, jsonl([prompt('x'), assistant('x')]));
  assert.equal(findTranscript('current-session', config), file);
  assert.equal(findTranscript('../escape', config), null);
  assert.equal(findTranscript('${CLAUDE_SESSION_ID}', config), null);
});

test('Codex accounts for every completed turn and flags incomplete turn counters', () => {
  const first = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 };
  const parsed = parseOutput('codex', { stdout: jsonl([{ type: 'turn.completed', usage: first }, { type: 'turn.completed', usage: first }]) });
  assert.equal(normalizeUsage('codex', parsed.usage).totalTokens, 220);
  assert.equal(parsed.usage.cached_input_tokens, 160);
  const partial = parseOutput('codex', { stdout: jsonl([{ type: 'turn.completed', usage: first }, { type: 'turn.completed' }]) });
  assert.equal(normalizeUsage('codex', partial.usage).partial, true);
  assert.equal(normalizeUsage('codex', partial.usage).totalTokens, 110);
});

test('the real CLI prints a compact report without starting a worker', () => {
  const opts = setup();
  worker(opts, 'worker', 'codex', { input_tokens: 100, output_tokens: 10 });
  const cli = new URL('../orch.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(cli), 'usage', 'report', '--repo', opts.repo, '--task', opts.task, '--session', opts.session], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Opus 5.5: 105 tokens/);
  assert.match(result.stdout, /Codex \/ GPT-6.1 Sol \/ medium: 110 tokens/);
  assert.match(result.stdout, /Total medido: 215 tokens/);
});
