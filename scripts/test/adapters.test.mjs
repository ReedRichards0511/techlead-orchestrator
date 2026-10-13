import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInvocation, parseOutput } from '../lib/adapters/index.mjs';
import { buildCatalog, parseDevinModels, parseCodexModels, parseAgyModels } from '../lib/catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, 'fixtures', f), 'utf8');
const config = JSON.parse(readFileSync(join(here, '..', '..', 'config.defaults.json'), 'utf8'));
const catalog = buildCatalog({
  discovered: [
    ...parseDevinModels(JSON.parse(fx('devin-models.json'))),
    ...parseCodexModels(JSON.parse(fx('codex-models.json'))),
    ...parseAgyModels(fx('agy-models.txt')),
  ],
  previous: null,
});
const entry = (id) => catalog.models.find((m) => m.id === id);
const common = { packetPath: '/r/runs/x/packet.md', repo: '/repo', config, runDir: '/r/runs/x' };

test('disabled permission bypasses explicitly keep Codex sandboxed and omit agy escalation', () => {
  const restricted = structuredClone(config);
  restricted.permissions.codex.bypassSandbox = false;
  restricted.permissions.agy.skipPermissions = false;
  const codex = buildInvocation({ ...common, config: restricted, entry: entry('codex/gpt-6.1-sol'), effort: 'high' });
  assert.ok(!codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(codex.args.includes('approval_policy="never"'));
  const agy = buildInvocation({ ...common, config: restricted, entry: entry('agy/gemini-3.8-flash'), effort: 'medium' });
  assert.ok(!agy.args.includes('--dangerously-skip-permissions'));
});

test('devin invocation uses a prompt file, effort inside the slug and smart permissions', () => {
  const inv = buildInvocation({ ...common, entry: entry('devin/gpt-6-1-sol'), effort: 'medium' });
  assert.equal(inv.exeName, 'devin');
  assert.deepEqual(inv.args, [
    '-p', '--prompt-file', '/r/runs/x/packet.md',
    '--model', 'gpt-6-1-sol-medium',
    '--respect-workspace-trust', 'false',
    '--permission-mode', 'smart',
    '--export', join('/r/runs/x', 'devin-session.json'),
  ]);
  assert.equal(inv.stdinPath, null);
  assert.equal(inv.cwd, '/repo');
});

test('devin invocation honors an explicit dangerous permission for the retry', () => {
  const inv = buildInvocation({ ...common, entry: entry('devin/swe-2'), effort: 'high', permission: 'dangerous' });
  assert.equal(inv.args[inv.args.indexOf('--permission-mode') + 1], 'dangerous');
  assert.ok(inv.args.includes('swe-2-high'));
});

test('codex invocation bypasses the sandbox, sets effort and reads the packet on stdin', () => {
  const inv = buildInvocation({ ...common, entry: entry('codex/gpt-6.1-sol'), effort: 'high' });
  assert.equal(inv.exeName, 'codex');
  assert.deepEqual(inv.args, [
    'exec', '--json', '-m', 'gpt-6.1-sol',
    '-c', 'model_reasoning_effort="high"',
    '--dangerously-bypass-approvals-and-sandbox',
    '-C', '/repo', '-',
  ]);
  assert.equal(inv.stdinPath, '/r/runs/x/packet.md');
  assert.equal(inv.args.includes('--ephemeral'), false);
});

test('codex never gets ultra', () => {
  assert.throws(() => buildInvocation({ ...common, entry: entry('codex/gpt-6.1-sol'), effort: 'ultra' }), /effort/);
});

test('agy invocation puts --print last, uses base model plus --effort and skips permissions', () => {
  const inv = buildInvocation({ ...common, entry: entry('agy/gemini-3.8-flash'), effort: 'high' });
  assert.equal(inv.exeName, 'agy');
  assert.deepEqual(inv.args.slice(0, 9), [
    '--model', 'gemini-3.8-flash', '--effort', 'high',
    '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--print-timeout', '0',
  ]);
  const last = inv.args.at(-1);
  assert.match(last, /^--print=/);
  assert.match(last, /\/r\/runs\/x\/packet\.md/);
  assert.equal(inv.args.filter((a) => a.startsWith('--print=')).length, 1);
  assert.equal(inv.stdinPath, null);
});

test('agy rejects an effort the model does not offer', () => {
  assert.throws(() => buildInvocation({ ...common, entry: entry('agy/gemini-3.8-flash'), effort: 'max' }), /effort/);
});

test('devin parse detects the silent permission block', () => {
  const p = parseOutput('devin', {
    exitCode: 0,
    stdout: '',
    stderr: 'warning: rejected a tool call that requires confirmation. Running in non-interactive mode. Use --permission-mode dangerous to auto-approve all tools.',
  });
  assert.equal(p.blocked, true);
});

test('devin invocation without a run directory does not ask for an export', () => {
  const inv = buildInvocation({ packetPath: '/p.md', repo: '/repo', config, entry: entry('devin/swe-2'), effort: 'high' });
  assert.equal(inv.args.includes('--export'), false);
});

function sessionExport(results) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ad-'));
  const calls = results.map((r, i) => ({ tool_call_id: 'c' + i, function_name: 'exec', arguments: { command: r.command } }));
  const observation = { results: results.map((r, i) => ({ source_call_id: 'c' + i, content: r.content })) };
  writeFileSync(join(dir, 'devin-session.json'), JSON.stringify({ steps: [{ source: 'agent', tool_calls: calls, observation }] }));
  return dir;
}

test('devin parse lists the rejected tool calls from the session export', () => {
  const runDir = sessionExport([
    { command: 'npm run lint', content: 'ok' },
    { command: 'rm -f victim.txt', content: 'Tool execution was rejected by the user' },
  ]);
  const p = parseOutput('devin', { exitCode: 0, stdout: '', stderr: 'warning: rejected a tool call that requires confirmation.', runDir });
  assert.equal(p.blocked, true);
  assert.deepEqual(p.blockedCalls, [{ tool: 'exec', command: 'rm -f victim.txt' }]);
});

test('devin parse treats a rejection in the export as blocked even without the stderr warning', () => {
  const runDir = sessionExport([{ command: 'npm test', content: 'Tool execution was rejected by the user' }]);
  const p = parseOutput('devin', { exitCode: 0, stdout: '', stderr: '', runDir });
  assert.equal(p.blocked, true);
});

test('devin parse without an export leaves blockedCalls empty', () => {
  const p = parseOutput('devin', { exitCode: 0, stdout: '', stderr: 'warning: rejected a tool call that requires confirmation.', runDir: tmpdir() });
  assert.equal(p.blocked, true);
  assert.deepEqual(p.blockedCalls, []);
});

test('devin parse leaves normal output alone', () => {
  const p = parseOutput('devin', { exitCode: 0, stdout: 'PONG\n', stderr: '' });
  assert.equal(p.blocked, false);
  assert.equal(p.text, 'PONG');
});

test('codex parse extracts thread id, last message and usage from JSONL', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t-123"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ].join('\n');
  const p = parseOutput('codex', { exitCode: 0, stdout, stderr: 'rmcp noise' });
  assert.equal(p.threadId, 't-123');
  assert.equal(p.lastMessage, 'PONG');
  assert.equal(p.completed, true);
  assert.equal(p.sawEvents, true);
  assert.deepEqual(p.errors, []);
});

test('codex parse collects error events and failed turns', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t-9"}',
    '{"type":"error","message":"You exceeded your current quota"}',
    '{"type":"turn.failed","error":{"message":"usage limit reached"}}',
  ].join('\n');
  const p = parseOutput('codex', { exitCode: 1, stdout, stderr: '' });
  assert.equal(p.completed, false);
  assert.deepEqual(p.errors, ['You exceeded your current quota', 'usage limit reached']);
});

test('codex parse reports no events when stdout has no JSON', () => {
  assert.equal(parseOutput('codex', { exitCode: 0, stdout: 'plain text', stderr: '' }).sawEvents, false);
});

test('codex parse ignores non-JSON lines', () => {
  const p = parseOutput('codex', { exitCode: 0, stdout: 'garbage\n{"type":"turn.completed"}\n', stderr: '' });
  assert.equal(p.completed, true);
});

test('agy parse reads the stream-json result event', () => {
  const stdout = [
    '{"event":"init","model":"gemini-3.8-flash","cwd":"/repo","tools":[],"permission_mode":"bypass"}',
    '{"event":"result","result":{"status":"SUCCESS","response":"PONG","error":"","usage":{"total_tokens":5},"denied_actions":[]}}',
  ].join('\n');
  const p = parseOutput('agy', { exitCode: 0, stdout, stderr: '' });
  assert.equal(p.status, 'SUCCESS');
  assert.equal(p.response, 'PONG');
  assert.deepEqual(p.deniedActions, []);
});

test('agy parse surfaces errors and denied actions', () => {
  const err = parseOutput('agy', {
    exitCode: 1,
    stdout: '{"event":"result","result":{"status":"ERROR","error":"invalid model selection (--model \\"x\\")","denied_actions":[]}}',
    stderr: '',
  });
  assert.equal(err.status, 'ERROR');
  assert.match(err.error, /invalid model selection/);
  const denied = parseOutput('agy', {
    exitCode: 0,
    stdout: '{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}',
    stderr: '',
  });
  assert.equal(denied.deniedActions.length, 1);
});

test('agy parse also accepts a plain json object', () => {
  const p = parseOutput('agy', { exitCode: 0, stdout: '{"status":"SUCCESS","response":"PONG\\n","denied_actions":[]}', stderr: '' });
  assert.equal(p.status, 'SUCCESS');
});

test('agy parse with no result event yields an unknown status', () => {
  const p = parseOutput('agy', { exitCode: 0, stdout: '', stderr: '' });
  assert.equal(p.status, null);
});
