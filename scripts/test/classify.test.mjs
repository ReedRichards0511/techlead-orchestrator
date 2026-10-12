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

test('devin silent block with no result retries with dangerous (D4)', () => {
  const r = classifyRun(base({ parsed: { blocked: true } }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'retry-dangerous');
});

test('devin block while already dangerous falls back', () => {
  const r = classifyRun(base({ parsed: { blocked: true }, permission: 'dangerous' }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'fallback');
});

test('devin block after partial edits continues instead of restarting', () => {
  const r = classifyRun(base({ parsed: { blocked: true }, diffEmpty: false }));
  assert.equal(r.status, 'PERMISSION_FAILURE');
  assert.equal(r.action, 'retry-dangerous');
  assert.equal(r.phase, 'DURING_WORK');
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
