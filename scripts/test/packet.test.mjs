import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPacket, renderRepairPacket, renderContinuationPacket } from '../lib/packet.mjs';

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config.defaults.json'), 'utf8'));

const opts = {
  runId: 'plan1-20261012T120000',
  project: 'demo',
  stack: 'node',
  title: 'Add OK line',
  klass: 'SMALL_FIX',
  planPath: 'C:/repo/.orchestrator/plans/plan1.md',
  workspace: 'C:/repo',
  resultPath: 'C:/repo/.orchestrator/runs/plan1-20261012T120000/result.json',
  projectRules: 'Use 2 spaces.',
  baseline: 'npm test: passes',
  config,
};

test('packet references the plan by path and never embeds it', () => {
  const p = renderPacket({ ...opts, planBody: 'SECRET-PLAN-BODY' });
  assert.match(p, /PLAN_PATH: C:\/repo\/\.orchestrator\/plans\/plan1\.md/);
  assert.equal(p.includes('SECRET-PLAN-BODY'), false);
});

test('packet carries the header fields from the plan', () => {
  const p = renderPacket(opts);
  assert.match(p, /# IMPLEMENTATION PACKET plan1-20261012T120000/);
  assert.match(p, /PROJECT: demo · node/);
  assert.match(p, /TASK: Add OK line · CLASS: SMALL_FIX/);
  assert.match(p, /WORKSPACE: C:\/repo/);
  assert.match(p, /RESULT_PATH: C:\/repo\/\.orchestrator\/runs\/plan1-20261012T120000\/result\.json/);
  assert.match(p, /PROJECT_RULES:[\s\S]*Use 2 spaces\./);
  assert.match(p, /BASELINE:[\s\S]*npm test: passes/);
});

test('packet states every contract rule', () => {
  const p = renderPacket(opts);
  for (const needle of [
    'NO_COMMENTS_POLICY',
    'SCOPE_POLICY',
    'CONTRADICTION_POLICY',
    'PLAN_CONTRADICTION',
    'VALIDATION_POLICY',
    'GIT_POLICY',
    'FORBIDDEN_COMMANDS',
    'Do not add comments',
    'single run',
    'Never write outside WORKSPACE',
  ]) {
    assert.ok(p.includes(needle), `missing: ${needle}`);
  }
});

test('packet lists every forbidden command from the config', () => {
  const p = renderPacket(opts);
  for (const c of config.forbiddenCommands) assert.ok(p.includes(c), c);
});

test('packet ends with the result.json schema', () => {
  const p = renderPacket(opts);
  assert.match(p, /EXPECTED_OUTPUT: write RESULT_PATH/);
  for (const key of ['status', 'summary', 'modifiedFiles', 'planStepsCompleted', 'validation', 'planContradiction', 'errors']) {
    assert.ok(p.includes(`"${key}"`), key);
  }
  assert.ok(p.indexOf('EXPECTED_OUTPUT') > p.indexOf('FORBIDDEN_COMMANDS'));
});

test('missing optional fields get explicit placeholders', () => {
  const p = renderPacket({ ...opts, projectRules: undefined, baseline: undefined });
  assert.match(p, /PROJECT_RULES: \(none provided\)/);
  assert.match(p, /BASELINE: \(none recorded\)/);
});

test('repair packet lists each failed point with evidence and keeps the contract', () => {
  const p = renderRepairPacket({
    ...opts,
    cycle: 1,
    points: [
      { file: 'src/a.ts', line: 42, issue: 'Missing null check', expected: 'guard before use' },
      { file: 'src/b.ts', line: 7, issue: 'Added a comment' },
    ],
    commands: ['npm run typecheck', 'npm test'],
  });
  assert.match(p, /REPAIR PACKET/);
  assert.match(p, /src\/a\.ts:42/);
  assert.match(p, /Missing null check/);
  assert.match(p, /npm run typecheck/);
  assert.match(p, /Do not redo the plan/);
  assert.match(p, /NO_COMMENTS_POLICY/);
  assert.match(p, /PLAN_PATH:/);
});

test('continuation packet states what is done, what is missing and where to continue', () => {
  const p = renderContinuationPacket({
    ...opts,
    done: ['Step 1', 'Step 2'],
    missing: ['Step 3', 'Step 4'],
    testsPassed: ['npm run lint'],
    testsFailed: ['npm test'],
    resumeAt: 'Step 3 in src/c.ts',
    changedFiles: ['src/a.ts', 'src/b.ts'],
  });
  assert.match(p, /CONTINUATION PACKET/);
  assert.match(p, /Step 1/);
  assert.match(p, /Step 3 in src\/c\.ts/);
  assert.match(p, /src\/a\.ts/);
  assert.match(p, /Do not restart/);
  assert.match(p, /FORBIDDEN_COMMANDS/);
});

test('every packet kind tells the worker that .orchestrator is read-only and must not be referenced from code', () => {
  const kinds = [
    renderPacket(opts),
    renderRepairPacket({ ...opts, cycle: 1, points: [{ file: 'a.ts', line: 1, issue: 'x', expected: 'y' }], commands: [] }),
    renderContinuationPacket({ ...opts, done: [], missing: ['s'], changedFiles: [], testsPassed: [], testsFailed: [], resumeAt: 'paso 1' }),
  ];
  for (const p of kinds) {
    assert.match(p, /RUNNER_FILES_POLICY: .*\.orchestrator.*read-only/s);
    assert.match(p, /never (import|read|reference)/i);
  }
});
