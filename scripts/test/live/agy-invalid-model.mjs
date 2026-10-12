import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startRun, waitRun } from '../../lib/run.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { gitPorcelain } from '../../lib/git.mjs';

const stateDir = mkdtempSync(join(tmpdir(), 'orch-live-state-'));
const config = loadConfig({ stateDir });
const repo = mkdtempSync(join(tmpdir(), 'orch-live-agy-bad-'));
spawnSync('git', ['init', '-q'], { cwd: repo });
mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
const planPath = join(repo, '.orchestrator', 'plans', 'bad1.md');
writeFileSync(planPath, '# Plan bad1\n');

const entry = {
  id: 'agy/gemini-9-flash',
  harness: 'agy',
  displayName: 'Nonexistent',
  slugTemplate: 'gemini-9-flash',
  efforts: ['low', 'medium', 'high'],
  allowedEfforts: ['low', 'medium', 'high'],
  enabled: true,
};
const run = startRun({ repo, planPath, klass: 'SMALL_FIX', entry, effort: 'high', config, snapshot: { porcelain: gitPorcelain(repo) } });
const st = await waitRun({ repo, runId: run.runId, timeoutMs: 120000 });
console.log(JSON.stringify({ state: st.state, exitCode: st.exitCode, classification: st.classification }, null, 2));
process.exit(st.classification?.status === 'MODEL_UNAVAILABLE' ? 0 : 1);
