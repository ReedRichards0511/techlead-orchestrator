import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlanValidation, parseScope, matchScope, runValidation, compareToBaseline } from '../lib/validate.mjs';

test('parsePlanValidation reads backtick-quoted commands', () => {
  const plan = '## Validation\n- Commands: `npm run typecheck`, `npm test`\n- Done when: green\n';
  assert.deepEqual(parsePlanValidation(plan), ['npm run typecheck', 'npm test']);
});

test('parsePlanValidation reads semicolon lists and sub-bullets', () => {
  assert.deepEqual(parsePlanValidation('## Validation\n- Commands: npm run lint; npm test\n'), ['npm run lint', 'npm test']);
  const nested = '## Validation\n- Commands:\n  - `./gradlew test`\n  - `npm run lint`\n- Baseline: x\n';
  assert.deepEqual(parsePlanValidation(nested), ['./gradlew test', 'npm run lint']);
});

test('parsePlanValidation ignores other sections and returns [] when absent', () => {
  assert.deepEqual(parsePlanValidation('## Steps\n- Commands: `rm -rf x`\n'), []);
  assert.deepEqual(parsePlanValidation('# nothing'), []);
});

test('parseScope reads in-scope and out-of-scope lists', () => {
  const plan = '## Scope\n- In scope: `src/a.ts`, src/b.ts, lib/**\n- Out of scope: everything else, `docs/`\n\n## Steps\n';
  const s = parseScope(plan);
  assert.deepEqual(s.inScope, ['src/a.ts', 'src/b.ts', 'lib/**']);
  assert.deepEqual(s.outOfScope, ['everything else', 'docs/']);
});

test('parseScope supports sub-bullets and stops at the next section', () => {
  const plan = '## Scope\n- In scope:\n  - `a.txt`\n  - `src/`\n- Out of scope: the rest\n## Steps\n- In scope: nope\n';
  assert.deepEqual(parseScope(plan).inScope, ['a.txt', 'src/']);
});

test('parseScope without a Scope section yields empty lists', () => {
  assert.deepEqual(parseScope('# plan'), { inScope: [], outOfScope: [] });
});

test('matchScope handles exact paths, directories and globs', () => {
  assert.equal(matchScope('src/a.ts', ['src/a.ts']), true);
  assert.equal(matchScope('src/a.ts', ['src/']), true);
  assert.equal(matchScope('src/deep/a.ts', ['src/']), true);
  assert.equal(matchScope('src/a.ts', ['src/*.ts']), true);
  assert.equal(matchScope('src/deep/a.ts', ['src/*.ts']), false);
  assert.equal(matchScope('src/deep/a.ts', ['src/**']), true);
  assert.equal(matchScope('lib/x.ts', ['src/']), false);
  assert.equal(matchScope('a.txt', ['a.txt', 'b.txt']), true);
  assert.equal(matchScope('src\\a.ts', ['src/a.ts']), true);
  assert.equal(matchScope('x', []), false);
});

const cwd = mkdtempSync(join(tmpdir(), 'orch-val-'));

test('runValidation records pass and fail per command', async () => {
  const results = await runValidation({ repo: cwd, commands: ['node -v', 'node --definitely-not-a-flag'], timeoutMs: 30000 });
  assert.equal(results[0].passed, true);
  assert.equal(results[0].exitCode, 0);
  assert.equal(results[1].passed, false);
  assert.notEqual(results[1].exitCode, 0);
  assert.ok(typeof results[1].tail === 'string');
});

test('runValidation refuses commands containing a forbidden string', async () => {
  const results = await runValidation({ repo: cwd, commands: ['git push origin main'], forbidden: ['git push'], timeoutMs: 5000 });
  assert.equal(results[0].passed, false);
  assert.equal(results[0].blocked, true);
  assert.equal(results[0].exitCode, null);
});

test('runValidation enforces a timeout', async () => {
  const results = await runValidation({ repo: cwd, commands: ['node -e "setInterval(()=>{},1000)"'], timeoutMs: 700 });
  assert.equal(results[0].passed, false);
  assert.equal(results[0].timedOut, true);
});

test('compareToBaseline separates regressions, pre-existing failures and fixes', () => {
  const baseline = [
    { command: 'lint', passed: true },
    { command: 'test', passed: false },
    { command: 'typecheck', passed: false },
  ];
  const current = [
    { command: 'lint', passed: false },
    { command: 'test', passed: false },
    { command: 'typecheck', passed: true },
    { command: 'build', passed: false },
  ];
  const c = compareToBaseline(baseline, current);
  assert.deepEqual(c.regressions.map((r) => r.command).sort(), ['build', 'lint']);
  assert.deepEqual(c.preexisting.map((r) => r.command), ['test']);
  assert.deepEqual(c.fixed.map((r) => r.command), ['typecheck']);
});
