import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { guardTechLead, closeTechLead } from '../lib/techlead-guard.mjs';
import { startUsage, reportUsage } from '../lib/usage.mjs';

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-role-'));
  startUsage({ repo, task: 'task', session: 'session' });
  mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
  writeFileSync(join(repo, '.orchestrator', 'plans', 'task.md'), '## Scope\n- In scope: src/\n## Validation\n- Commands: `npm run validate`\n');
  const act = (tool, input, extra = {}) => guardTechLead({ cwd: repo, session_id: 'session', tool_name: tool, tool_input: input, ...extra });
  return { repo, act };
}

test('Opus cannot edit product code, tests or docs, but can write plans and audit records', () => {
  const { repo, act } = setup();
  for (const file_path of ['src/Card.tsx', '__test__/Card.test.tsx', 'docs/readme.md', '.orchestrator/runs/task-run/result.json', '.orchestrator/usage/task.json']) assert.equal(act('Write', { file_path }).hookSpecificOutput.permissionDecision, 'deny', file_path);
  for (const file_path of ['.orchestrator/plans/task.md', '.orchestrator/plans/continuation.json', '.orchestrator/runs/task-run/audit.md', '.orchestrator/project-context.md']) assert.equal(act('Write', { file_path }), null);
  assert.equal(act('Edit', { file_path: join(repo, 'src/Card.tsx') }).hookSpecificOutput.permissionDecision, 'deny');
});

test('Opus can inspect, validate and invoke the runner, but cannot perform mechanical changes through shell', () => {
  const { repo, act } = setup();
  const runner = fileURLToPath(new URL('../orch.mjs', import.meta.url));
  for (const command of ['git status --short', 'git diff -- src/', 'rg -n TODO src/', 'npm run validate', `cd "${repo}" && node "${runner}" wait task-run --until-ended --json`, `node "${runner}" go --plan .orchestrator/plans/task.md --class FEATURE --model m --effort medium`, `node "${runner}" close task-run --task task --verdict PASS`, 'sed -n \'1,20p\' README.md']) assert.equal(act('Bash', { command }), null, command);
  for (const command of ['git mv src/a.ts src/b.ts', 'rm src/a.ts', 'mv src/a.ts src/b.ts', 'cp src/a.ts src/b.ts', 'echo x > src/a.ts', 'node -e "require(\'fs\').writeFileSync(\'src/a.ts\',\'x\')"', 'sed -i \'s/a/b/\' src/a.ts', `node "${runner}" worker-files --run task-run --operation 1`, 'cat README.md && rm src/a.ts', 'rg --pre=malicious-script src/', 'git diff --output=src/a.ts']) assert.equal(act('Bash', { command }).hookSpecificOutput.permissionDecision, 'deny', command);
});

test('role protection is session-specific, covers nested paths and stays active through the final response', () => {
  const { repo, act } = setup();
  assert.equal(act('Write', { file_path: 'src/a.ts' }, { session_id: 'other' }), null);
  mkdirSync(join(repo, 'src'));
  assert.equal(act('Write', { file_path: 'a.ts' }, { cwd: join(repo, 'src') }).hookSpecificOutput.permissionDecision, 'deny');
  reportUsage({ repo, task: 'task', session: 'session' });
  assert.equal(act('Write', { file_path: 'src/a.ts' }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(closeTechLead({ cwd: repo, session_id: 'session' }), true);
  assert.equal(act('Write', { file_path: 'src/a.ts' }), null);
});

test('the real hook emits the Claude denial schema without changing product files', () => {
  const { repo } = setup();
  const hook = fileURLToPath(new URL('../techlead-guard.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [hook], { input: JSON.stringify({ cwd: repo, session_id: 'session', tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
