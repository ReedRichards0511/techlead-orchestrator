import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { matchScope, parsePlanValidation, parseScope } from '../scripts/lib/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const iterDir = process.argv[2];
if (!iterDir) {
  console.error('Usage: node grade.mjs <iterationDir>');
  process.exit(2);
}

const spec = JSON.parse(readFileSync(join(here, 'evals.json'), 'utf8'));
const NAMES = ['plan-and-route', 'plan-contradiction-no-fallback', 'quota-fallback-before-work'];
const SEEDED_RUNS = { 'plan-and-route': [], 'plan-contradiction-no-fallback': ['add-retry-20261012T100000'], 'quota-fallback-before-work': ['user-search-20261012T101500'] };

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const git = (repo, ...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim();
const ls = (p) => (existsSync(p) ? readdirSync(p) : []);

function common(repo, name) {
  const runs = ls(join(repo, '.orchestrator', 'runs')).filter((r) => !SEEDED_RUNS[name].includes(r));
  const commits = git(repo, 'rev-list', '--count', 'HEAD');
  const srcDiff = git(repo, 'diff', 'HEAD', '--stat', '--', 'src', 'test');
  const untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '--', 'src', 'test');
  return { runs, commits, srcDiff, untracked };
}

function planOf(repo, id) {
  const dir = join(repo, '.orchestrator', 'plans');
  const files = ls(dir).filter((f) => f.endsWith('.md'));
  const pick = id ? files.filter((f) => f === `${id}.md`) : files;
  return pick.map((f) => ({ file: f, text: read(join(dir, f)) }));
}

const checks = {
  'plan-and-route': ({ repo, report, c }) => {
    const plans = planOf(repo);
    const plan = plans[0]?.text ?? '';
    const scope = parseScope(plan);
    const cmds = parsePlanValidation(plan);
    const snaps = ls(join(repo, '.orchestrator', 'snapshots'));
    return [
      [plans.length > 0, `plans: ${plans.map((p) => p.file).join(', ') || 'none'}`],
      [matchScope('src/api/client.js', scope.inScope), `inScope: ${JSON.stringify(scope.inScope)}`],
      [cmds.some((x) => /^npm (run )?test\b/.test(x)), `commands: ${JSON.stringify(cmds)}`],
      [/\b(SMALL_FIX|BUG_SIMPLE)\b/.test(report) && !/Task class:\s*(FEATURE|REFACTOR|MIGRATION)/.test(report), 'class mention in report'],
      [/ROUTING DECISION/.test(report) && /Selected:/.test(report) && /Fallback/i.test(report), 'ROUTING DECISION block'],
      [snaps.length > 0, `snapshots: ${snaps.join(', ') || 'none'}`],
      [/orch(\.mjs)?\s+run\b[^\n]*--plan[^\n]*--class|orch(\.mjs)?\s+run\b[^\n]*--class[^\n]*--plan/.test(report), 'orch run command in report'],
      [c.runs.length === 0 && c.commits === '1' && !c.srcDiff && !c.untracked, `runs=${c.runs.length} commits=${c.commits} srcDiff=${c.srcDiff ? 'yes' : 'no'}`],
    ];
  },
  'plan-contradiction-no-fallback': ({ repo, report, c }) => {
    const plan = planOf(repo, 'add-retry')[0]?.text ?? '';
    const scope = parseScope(plan);
    return [
      [/PLAN_CONTRADICTION/.test(report) && /client\.js/.test(report) && /http\.js/.test(report), 'mentions contradiction, client.js and http.js'],
      [!/--exclude/.test(report) && !/orch(\.mjs)?\s+run\b[^\n]*--(model|harness)/.test(report), 'no --exclude / forced model in report'],
      [/sin fallback|no (hay|se hace|aplica|corresponde)[^\n]{0,30}fallback|nunca[^\n]{0,40}fallback|fallback[^\n]{0,60}(NONE|nunca|no )/i.test(report), 'states no fallback'],
      [/client\.js/.test(report) && /\b(get|post)\b/.test(report) && /(ls|grep|Read|le[ií]|verifiqu|inspeccion)/i.test(report), 'verification evidence in report'],
      [matchScope('src/api/client.js', scope.inScope) || /\?/.test(report), `inScope: ${JSON.stringify(scope.inScope)}`],
      [!c.srcDiff && !c.untracked, `srcDiff=${c.srcDiff ? 'yes' : 'no'} untracked=${c.untracked || 'none'}`],
      [c.runs.length === 0 && c.commits === '1', `runs=${c.runs.length} commits=${c.commits}`],
    ];
  },
  'quota-fallback-before-work': ({ repo, report, c }) => [
    [/QUOTA_EXHAUSTED/.test(report) && /BEFORE_WORK/.test(report), 'QUOTA_EXHAUSTED + BEFORE_WORK in report'],
    [/quota refresh/.test(report), 'quota refresh in report'],
    [/--exclude\s+codex\/gpt-6\.1-sol@medium/.test(report), '--exclude codex/gpt-6.1-sol@medium'],
    [!/orch(\.mjs)?\s+run\b[^\n]*--model\s+codex\/gpt-6\.1-sol/.test(report), 'no run forcing codex sol'],
    [!/orch(\.mjs)?\s+run\b[^\n]*--continuation/.test(report) && !ls(join(repo, '..', 'outputs')).some((f) => /continuation/i.test(f)), 'no continuation run'],
    [/ROUTING DECISION/.test(report) || /orch(\.mjs)?\s+route\b/.test(report), 'route recalculated'],
    [c.runs.length === 0 && c.commits === '1', `runs=${c.runs.length} commits=${c.commits}`],
  ],
};

const rows = [];
NAMES.forEach((name, idx) => {
  const expectations = spec.evals[idx].expectations;
  for (const cfg of ['with_skill', 'without_skill']) {
    const base = join(iterDir, name, cfg);
    if (!existsSync(base)) continue;
    const repo = join(base, 'repo');
    const report = read(join(base, 'outputs', 'report.md'));
    if (!report) {
      writeFileSync(join(base, 'grading.json'), JSON.stringify({ expectations: expectations.map((text) => ({ text, passed: false, evidence: 'no report.md produced' })), summary: { passed: 0, failed: expectations.length, total: expectations.length, pass_rate: 0 } }, null, 2));
      rows.push({ name, cfg, passed: 0, total: expectations.length });
      continue;
    }
    const results = checks[name]({ repo, report, c: common(repo, name) });
    const graded = expectations.map((text, i) => ({ text, passed: Boolean(results[i][0]), evidence: results[i][1] }));
    const passed = graded.filter((g) => g.passed).length;
    writeFileSync(join(base, 'grading.json'), JSON.stringify({ expectations: graded, summary: { passed, failed: graded.length - passed, total: graded.length, pass_rate: passed / graded.length } }, null, 2));
    rows.push({ name, cfg, passed, total: graded.length, failed: graded.filter((g) => !g.passed).map((g) => g.text.slice(0, 70)) });
  }
});
console.log(JSON.stringify(rows, null, 2));
