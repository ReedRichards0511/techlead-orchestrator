import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, validateResult } from '../lib/classify.mjs';

const okResult = (over = {}) => ({
  status: 'SUCCESS',
  summary: 'done',
  modifiedFiles: [{ path: 'a.txt', change: 'modified' }],
  planStepsCompleted: ['1'],
  validation: [{ command: 'npm test', result: 'pass', baselineFailed: false, notes: '' }],
  errors: [],
  ...over,
});

const base = (over = {}) => ({
  harness: 'devin',
  state: 'exited',
  exitCode: 0,
  stderr: '',
  parsed: {},
  result: null,
  resultInvalid: false,
  diffEmpty: true,
  permission: 'smart',
  rateRetries: 0,
  ...over,
});

test('validateResult accepts a well-formed SUCCESS result', () => {
  assert.deepEqual(validateResult(okResult()), { ok: true, errors: [] });
});

test('validateResult rejects bad status, missing arrays and bad entries', () => {
  assert.equal(validateResult(okResult({ status: 'DONE' })).ok, false);
  assert.equal(validateResult({ status: 'SUCCESS' }).ok, false);
  assert.equal(validateResult(okResult({ modifiedFiles: [{ path: 'x', change: 'renamed' }] })).ok, false);
  assert.equal(validateResult(okResult({ validation: [{ command: 'x', result: 'maybe' }] })).ok, false);
  assert.equal(validateResult(null).ok, false);
});

test('validateResult requires evidence for PLAN_CONTRADICTION', () => {
  const missing = validateResult(okResult({ status: 'PLAN_CONTRADICTION' }));
  assert.equal(missing.ok, false);
  const good = validateResult(
    okResult({
      status: 'PLAN_CONTRADICTION',
      planContradiction: { section: 'Step 3', planAssumption: 'a', reality: 'b', evidence: 'src/a.ts:42' },
    }),
  );
  assert.equal(good.ok, true);
});

test('a valid SUCCESS result goes to postflight', () => {
  const r = classifyRun(base({ result: okResult() }));
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.action, 'postflight');
});

test('PLAN_CONTRADICTION never falls back', () => {
  const r = classifyRun(
    base({
      result: okResult({
        status: 'PLAN_CONTRADICTION',
        planContradiction: { section: 's', planAssumption: 'a', reality: 'b', evidence: 'e' },
      }),
      diffEmpty: false,
    }),
  );
  assert.equal(r.status, 'PLAN_CONTRADICTION');
  assert.equal(r.action, 'stop-opus');
  assert.equal(r.fallback, false);
});

test('VALIDATION_FAILURE goes to audit for a repair, not a fallback', () => {
  const r = classifyRun(base({ result: okResult({ status: 'VALIDATION_FAILURE' }) }));
  assert.equal(r.status, 'VALIDATION_FAILURE');
  assert.equal(r.action, 'audit');
  assert.equal(r.fallback, false);
});

const planText = '# Plan\n## Validation\n- Commands: `npm run lint` `npm test`\n';
const gate = { planText, forbidden: ['git commit'], repo: 'C:/work/todo' };
const blockedOn = (...commands) => ({ blocked: true, blockedCalls: commands.map((command) => ({ tool: 'exec', command })) });

test('devin block on a command named in the plan retries with a specific allowlist, never dangerous', () => {
  const r = classifyRun(base({ parsed: blockedOn('npm run lint'), ...gate }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'retry-allowlist');
  assert.deepEqual(r.allowExec, ['npm run lint']);
  assert.equal(r.fallback, false);
});

test('devin block on a destructive command stops and goes to Reed', () => {
  const r = classifyRun(base({ parsed: blockedOn('rm -f victim.txt'), ...gate }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'stop-reed');
  assert.deepEqual(r.allowExec, []);
  assert.equal(r.blocked[0].verdict, 'stop');
});

test('devin block on a command the plan never names stops and goes to Reed', () => {
  const r = classifyRun(base({ parsed: blockedOn('node scripts/other.js'), ...gate }));
  assert.equal(r.action, 'stop-reed');
  assert.equal(r.blocked[0].verdict, 'unknown');
});

test('devin block that cannot be inspected stops instead of escalating', () => {
  const r = classifyRun(base({ parsed: { blocked: true }, ...gate }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'stop-reed');
  assert.match(r.detail, /could not be inspected/i);
});

test('devin block after an allowlist retry already happened stops instead of looping', () => {
  const r = classifyRun(base({ parsed: blockedOn('npm run lint'), allowlistRetry: true, ...gate }));
  assert.equal(r.action, 'stop-reed');
});

test('devin block while already dangerous stops', () => {
  const r = classifyRun(base({ parsed: blockedOn('npm run lint'), permission: 'dangerous', ...gate }));
  assert.equal(r.action, 'stop-reed');
});

test('devin block after partial edits keeps the phase so the retry can continue', () => {
  const r = classifyRun(base({ parsed: blockedOn('npm test'), diffEmpty: false, ...gate }));
  assert.equal(r.action, 'retry-allowlist');
  assert.equal(r.phase, 'DURING_WORK');
});

test('no classification ever asks for an automatic dangerous retry', () => {
  const cases = [blockedOn('npm run lint'), blockedOn('rm -f x'), { blocked: true }, blockedOn('npm run lint', 'echo hi')];
  for (const parsed of cases) {
    for (const permission of ['smart', 'dangerous']) {
      assert.notEqual(classifyRun(base({ parsed, permission, ...gate })).action, 'retry-dangerous');
    }
  }
});

test('a worker that reports SUCCESS while a tool call was rejected is not a success', () => {
  const r = classifyRun(base({ result: okResult(), parsed: blockedOn('npm run lint'), diffEmpty: false, ...gate }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.notEqual(r.action, 'postflight');
});

test('a VALIDATION_FAILURE report with a rejected tool call is a permission failure', () => {
  const r = classifyRun(base({ result: okResult({ status: 'VALIDATION_FAILURE' }), parsed: blockedOn('npm test'), diffEmpty: false, ...gate }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
});

test('PLAN_CONTRADICTION wins over a rejected tool call and still never falls back', () => {
  const result = okResult({ status: 'PLAN_CONTRADICTION', planContradiction: { section: 's', planAssumption: 'a', reality: 'b', evidence: 'e' } });
  const r = classifyRun(base({ result, parsed: blockedOn('npm test'), ...gate }));
  assert.equal(r.status, 'PLAN_CONTRADICTION');
  assert.equal(r.fallback, false);
});

test('agy denied actions override a SUCCESS report', () => {
  const r = classifyRun(base({ harness: 'agy', result: okResult(), parsed: { status: 'SUCCESS', deniedActions: [{ action: 'command' }] }, diffEmpty: false }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'continuation');
});

test('codex that saw events but never completed is not a success even with a SUCCESS report', () => {
  const r = classifyRun(base({ harness: 'codex', result: okResult(), parsed: { sawEvents: true, completed: false, errors: [] }, diffEmpty: false }));
  assert.equal(r.status, 'EXECUTION_FAILURE');
  assert.equal(r.action, 'continuation');
});

test('codex that completed with a SUCCESS report is a success', () => {
  const r = classifyRun(base({ harness: 'codex', result: okResult(), parsed: { sawEvents: true, completed: true, errors: [] } }));
  assert.equal(r.status, 'SUCCESS');
});

test('codex turn.failed with exit 0 and no report is never a success', () => {
  const r = classifyRun(base({ harness: 'codex', exitCode: 0, parsed: { sawEvents: true, completed: false, errors: ['turn failed'] } }));
  assert.notEqual(r.status, 'SUCCESS');
});

test('exit 0 with empty output and no report is never a success', () => {
  for (const harness of ['devin', 'codex', 'agy']) {
    const r = classifyRun(base({ harness, exitCode: 0, parsed: {}, stderr: '' }));
    assert.equal(r.status, 'UNKNOWN_FAILURE', harness);
    assert.equal(r.action, 'ask-reed', harness);
  }
});

test('a SUCCESS report over an unchanged working tree is flagged noChanges for the postflight', () => {
  const r = classifyRun(base({ result: okResult(), diffEmpty: true }));
  assert.equal(r.status, 'SUCCESS');
  assert.equal(r.noChanges, true);
});

test('agy denied actions are a permission failure and fall back', () => {
  const r = classifyRun(base({ harness: 'agy', parsed: { status: 'SUCCESS', deniedActions: [{ action: 'command' }] } }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'fallback');
});

test('agy invalid model is MODEL_UNAVAILABLE and falls back before work', () => {
  const r = classifyRun(
    base({ harness: 'agy', exitCode: 1, parsed: { status: 'ERROR', error: 'invalid model selection (--model "x" --effort "max"): no max effort' } }),
  );
  assert.equal(r.status, 'MODEL_UNAVAILABLE');
  assert.equal(r.action, 'fallback');
  assert.equal(r.phase, 'BEFORE_WORK');
});

test('codex quota error is QUOTA_EXHAUSTED', () => {
  const r = classifyRun(base({ harness: 'codex', exitCode: 1, parsed: { errors: ['You exceeded your current quota'] } }));
  assert.equal(r.status, 'QUOTA_EXHAUSTED');
  assert.equal(r.refreshQuota, true);
  assert.equal(r.action, 'fallback');
});

test('rate limit retries once after a short wait, then falls back', () => {
  const first = classifyRun(base({ exitCode: 1, stderr: 'HTTP 429 Too Many Requests' }));
  assert.equal(first.status, 'RATE_LIMITED');
  assert.equal(first.action, 'wait-retry');
  const second = classifyRun(base({ exitCode: 1, stderr: 'HTTP 429 Too Many Requests', rateRetries: 1 }));
  assert.equal(second.action, 'fallback');
});

test('network or auth problems are PROVIDER_UNAVAILABLE', () => {
  const r = classifyRun(base({ exitCode: 1, stderr: 'Error: getaddrinfo ENOTFOUND api.example.com' }));
  assert.equal(r.status, 'PROVIDER_UNAVAILABLE');
});

test('codex stderr noise is ignored when the exit code is 0', () => {
  const r = classifyRun(
    base({ harness: 'codex', exitCode: 0, stderr: 'ERROR rmcp::transport::worker: error sending request for url', parsed: { completed: true, errors: [] } }),
  );
  assert.notEqual(r.status, 'PROVIDER_UNAVAILABLE');
});

test('a timeout before any change falls back; after changes it needs a continuation', () => {
  const before = classifyRun(base({ state: 'timeout', exitCode: null, diffEmpty: true }));
  assert.equal(before.status, 'TIMEOUT');
  assert.equal(before.action, 'fallback');
  const during = classifyRun(base({ state: 'timeout', exitCode: null, diffEmpty: false }));
  assert.equal(during.action, 'continuation');
  assert.equal(during.phase, 'DURING_WORK');
});

test('non-zero exit with no result is EXECUTION_FAILURE', () => {
  const r = classifyRun(base({ exitCode: 2, stderr: 'boom' }));
  assert.equal(r.status, 'EXECUTION_FAILURE');
  assert.equal(r.action, 'fallback');
});

test('exit 0 with no result and no known signal asks Reed', () => {
  const r = classifyRun(base({ exitCode: 0 }));
  assert.equal(r.status, 'UNKNOWN_FAILURE');
  assert.equal(r.action, 'ask-reed');
});

test('an invalid result.json is treated as missing', () => {
  const r = classifyRun(base({ resultInvalid: true, exitCode: 0 }));
  assert.equal(r.status, 'UNKNOWN_FAILURE');
  assert.ok(r.detail.includes('result.json'));
});

test('unknown diff state is reported and handled conservatively', () => {
  const r = classifyRun(base({ exitCode: 3, diffEmpty: null }));
  assert.equal(r.status, 'EXECUTION_FAILURE');
  assert.equal(r.phase, 'UNKNOWN');
  assert.equal(r.action, 'continuation');
});

test('a worker spawn error is an execution failure', () => {
  const r = classifyRun(base({ state: 'error', exitCode: null }));
  assert.equal(r.status, 'EXECUTION_FAILURE');
});
