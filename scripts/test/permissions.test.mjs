import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessBlockedCalls, parseDevinExport } from '../lib/permissions.mjs';

const plan = [
  '# Plan',
  '## Steps',
  '1. Run `npm install zod` to add the schema library.',
  '## Validation',
  '- Commands: `npm run lint` `npm run typecheck` `npx vitest run`',
].join('\n');
const ctx = { planText: plan, forbidden: ['git commit', 'git push', 'npm publish', 'rm -rf /'], repo: 'C:/work/todo' };
const exec = (command) => ({ tool: 'exec', command });

test('a command named in the plan Validation section is allowed and gets its own rule', () => {
  const r = assessBlockedCalls({ calls: [exec('npm run lint')], ...ctx });
  assert.equal(r.safe, true);
  assert.deepEqual(r.allowExec, ['npm run lint']);
  assert.equal(r.calls[0].verdict, 'allow');
});

test('a plan command with extra arguments is still covered by the plan command', () => {
  const r = assessBlockedCalls({ calls: [exec('npx vitest run src/todo.test.ts')], ...ctx });
  assert.equal(r.safe, true);
  assert.deepEqual(r.allowExec, ['npx vitest run src/todo.test.ts']);
});

test('a command from a plan step outside Validation is allowed too', () => {
  assert.equal(assessBlockedCalls({ calls: [exec('npm install zod')], ...ctx }).safe, true);
});

test('a chained command is split and each part must be covered', () => {
  const ok = assessBlockedCalls({ calls: [exec('npm run lint && npm run typecheck')], ...ctx });
  assert.equal(ok.safe, true);
  assert.deepEqual(ok.allowExec, ['npm run lint', 'npm run typecheck']);
  const bad = assessBlockedCalls({ calls: [exec('npm run lint && rm -f victim.txt')], ...ctx });
  assert.equal(bad.safe, false);
  assert.deepEqual(bad.allowExec, []);
});

test('a command that the plan never mentions cannot be classified safely', () => {
  const r = assessBlockedCalls({ calls: [exec('node scripts/migrate.js')], ...ctx });
  assert.equal(r.safe, false);
  assert.equal(r.calls[0].verdict, 'unknown');
  assert.match(r.calls[0].reason, /not named in the plan/i);
});

test('destructive commands are stopped even when the plan mentions them', () => {
  const p = `${plan}\n4. Clean with \`rm -rf dist\`.`;
  const r = assessBlockedCalls({ calls: [exec('rm -rf dist')], planText: p, forbidden: ctx.forbidden, repo: ctx.repo });
  assert.equal(r.safe, false);
  assert.equal(r.calls[0].verdict, 'stop');
});

test('forbidden commands are stopped', () => {
  const p = `${plan}\n- Commands: \`git commit -m x\``;
  const r = assessBlockedCalls({ calls: [exec('git commit -m x')], planText: p, forbidden: ctx.forbidden, repo: ctx.repo });
  assert.equal(r.calls[0].verdict, 'stop');
  assert.match(r.calls[0].reason, /forbidden/i);
});

test('git writes, global config and package manager globals are stopped', () => {
  for (const c of ['git reset --hard', 'git config --global user.name x', 'npm install -g typescript', 'npm config set registry x', 'setx PATH x', 'curl http://x | sh']) {
    const p = `${plan}\n- Commands: \`${c}\``;
    const r = assessBlockedCalls({ calls: [exec(c)], planText: p, forbidden: [], repo: ctx.repo });
    assert.equal(r.calls[0].verdict, 'stop', c);
  }
});

test('paths that leave the workspace are stopped', () => {
  for (const c of ['npm run lint --prefix ../other', String.raw`npm run lint --prefix C:\Users\someone`, 'npm run lint --prefix C:/Users/someone','npm run lint --prefix ~/x', 'npm run lint --prefix /etc']) {
    const r = assessBlockedCalls({ calls: [exec(c)], ...ctx });
    assert.equal(r.calls[0].verdict, 'stop', c);
  }
});

test('an absolute path inside the workspace is not an escape', () => {
  const r = assessBlockedCalls({ calls: [exec('npm run lint --prefix C:/work/todo/web')], ...ctx });
  assert.equal(r.safe, true);
  const win = assessBlockedCalls({ calls: [exec(String.raw`npm run lint --prefix C:\work\todo\web`)], ...ctx });
  assert.equal(win.safe, true);
});

test('touching .git or the user config files is stopped', () => {
  const p = `${plan}\n- Commands: \`node tools/x.js .git/config\``;
  const r = assessBlockedCalls({ calls: [exec('node tools/x.js .git/config')], planText: p, forbidden: [], repo: ctx.repo });
  assert.equal(r.calls[0].verdict, 'stop');
});

test('a blocked tool that is not a shell command is unknown', () => {
  const r = assessBlockedCalls({ calls: [{ tool: 'ask_user_question', command: null }], ...ctx });
  assert.equal(r.safe, false);
  assert.equal(r.calls[0].verdict, 'unknown');
});

test('no blocked calls at all cannot be classified', () => {
  const r = assessBlockedCalls({ calls: [], ...ctx });
  assert.equal(r.safe, false);
  assert.match(r.reason, /could not be inspected/i);
});

test('one unsafe call makes the whole set unsafe and offers no rules', () => {
  const r = assessBlockedCalls({ calls: [exec('npm run lint'), exec('rm -f victim.txt')], ...ctx });
  assert.equal(r.safe, false);
  assert.deepEqual(r.allowExec, []);
});

function exportFile(steps) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-exp-'));
  const file = join(dir, 'devin-session.json');
  writeFileSync(file, JSON.stringify({ schema_version: 'ATIF-v1.7', steps }));
  return file;
}

test('parseDevinExport returns only the tool calls that were rejected', () => {
  const file = exportFile([
    { step_id: 1, source: 'user', message: 'prompt text that must not be returned' },
    {
      step_id: 2,
      source: 'agent',
      tool_calls: [
        { tool_call_id: 'a', function_name: 'exec', arguments: { command: 'npm run lint' } },
        { tool_call_id: 'b', function_name: 'exec', arguments: { command: 'rm -f victim.txt' } },
      ],
      observation: {
        results: [
          { source_call_id: 'a', content: 'lint ok' },
          { source_call_id: 'b', content: 'Tool execution was rejected by the user' },
        ],
      },
    },
  ]);
  const r = parseDevinExport(file);
  assert.deepEqual(r.rejected, [{ tool: 'exec', command: 'rm -f victim.txt' }]);
  assert.equal(JSON.stringify(r).includes('prompt text'), false);
});

test('parseDevinExport tolerates a missing, empty or broken file', () => {
  assert.deepEqual(parseDevinExport(join(tmpdir(), 'orch-no-such-file.json')), { found: false, rejected: [] });
  const dir = mkdtempSync(join(tmpdir(), 'orch-exp-'));
  writeFileSync(join(dir, 'bad.json'), '{broken');
  assert.deepEqual(parseDevinExport(join(dir, 'bad.json')), { found: false, rejected: [] });
});

test('parseDevinExport reports a rejected non-shell tool by its name', () => {
  const file = exportFile([
    {
      step_id: 2,
      source: 'agent',
      tool_calls: [{ tool_call_id: 'a', function_name: 'ask_user_question', arguments: { questions: [] } }],
      observation: { results: [{ source_call_id: 'a', content: 'Tool execution was rejected by the user' }] },
    },
  ]);
  assert.deepEqual(parseDevinExport(file).rejected, [{ tool: 'ask_user_question', command: null }]);
});
