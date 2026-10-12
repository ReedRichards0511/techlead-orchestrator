import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCatalog, parseDevinModels, parseCodexModels, parseAgyModels } from '../../lib/catalog.mjs';
import { startRun, waitRun } from '../../lib/run.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { preflight } from '../../lib/safety.mjs';
import { runPostflight } from '../../lib/postflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (f) => readFileSync(join(here, '..', 'fixtures', f), 'utf8');

const WORKERS = {
  devin: { id: 'devin/claude-haiku-5-5', effort: 'low' },
  codex: { id: 'codex/gpt-6-luna', effort: 'low' },
  agy: { id: 'agy/gemini-3.8-flash', effort: 'low' },
};

const which = process.argv[2];
const permission = process.argv[3];
const spec = WORKERS[which];
if (!spec) {
  console.error(`Usage: node smoke.mjs <${Object.keys(WORKERS).join('|')}> [permission]`);
  process.exit(2);
}

const catalog = buildCatalog({
  discovered: [
    ...parseDevinModels(JSON.parse(fx('devin-models.json'))),
    ...parseCodexModels(JSON.parse(fx('codex-models.json'))),
    ...parseAgyModels(fx('agy-models.txt')),
  ],
  previous: null,
});
const entry = catalog.models.find((m) => m.id === spec.id);
const stateDir = mkdtempSync(join(tmpdir(), 'orch-live-state-'));
const config = loadConfig({ stateDir });

const repo = mkdtempSync(join(tmpdir(), `orch-live-${which}-`));
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
git('init', '-q');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'tester');
writeFileSync(join(repo, 'a.txt'), 'hello\n');
writeFileSync(
  join(repo, 'package.json'),
  JSON.stringify({ name: 'live', version: '1.0.0', scripts: { test: "node -e \"if(!require('fs').readFileSync('a.txt','utf8').split(/\\r?\\n/).includes('OK'))process.exit(1)\"" } }, null, 2),
);
git('add', '-A');
git('commit', '-qm', 'init');
const head = git('rev-parse', 'HEAD').stdout.trim();

mkdirSync(join(repo, '.orchestrator', 'plans'), { recursive: true });
const planPath = join(repo, '.orchestrator', 'plans', 'live1.md');
writeFileSync(
  planPath,
  `# Plan live1: append OK
Class: SMALL_FIX · Estimated files: 1

## Scope
- In scope: a.txt
- Out of scope: everything else

## Steps
1. Append a new line containing exactly OK to the end of a.txt · files: a.txt

## Validation
- Commands: npm test
- Done when: npm test exits 0
`,
);

const pre = await preflight({ repo, planPath, config });
if (!pre.ok) { console.error(JSON.stringify(pre, null, 2)); process.exit(1); }
console.log('baseline:', JSON.stringify(pre.snapshot.baseline.map((b) => [b.command, b.passed])));
const run = startRun({ repo, planPath, klass: 'SMALL_FIX', entry, effort: spec.effort, config, permission });
console.log(`launched ${run.runId} (${spec.id} @ ${spec.effort}, permission ${permission ?? 'default'})`);

const st = await waitRun({ repo, runId: run.runId, timeoutMs: 8 * 60000 });
const a = readFileSync(join(repo, 'a.txt'), 'utf8');
const npmTest = spawnSync('npm', ['test', '--silent'], { cwd: repo, shell: true, encoding: 'utf8' });
const headAfter = git('rev-parse', 'HEAD').stdout.trim();
const post = await runPostflight({ repo, runId: run.runId, config });
const report = {
  postflight: { ok: post.ok, violations: post.violations, changed: post.changedFiles, regressions: post.validation.regressions, fixed: post.validation.fixed },
  state: st.state,
  exitCode: st.exitCode,
  elapsedSeconds: st.elapsedSeconds,
  classification: st.classification,
  aTxt: a,
  npmTestExit: npmTest.status,
  noNewCommits: head === headAfter,
  runDir: run.runDir,
};
console.log(JSON.stringify(report, null, 2));
process.exit(report.classification?.status === 'SUCCESS' && report.npmTestExit === 0 && report.noNewCommits && post.ok ? 0 : 1);
