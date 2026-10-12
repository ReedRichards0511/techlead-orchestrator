import { mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [outDir, ...configs] = process.argv.slice(2);
if (!outDir) {
  console.error('Usage: node make-fixtures.mjs <iterationDir> [config ...]  (default configs: with_skill without_skill)');
  process.exit(2);
}
const CONFIGS = configs.length ? configs : ['with_skill', 'without_skill'];

const w = (file, text) => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

function baseRepo(repo) {
  w(join(repo, 'package.json'), JSON.stringify({
    name: 'rn-app-mini',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test "test/*.test.js"' },
  }, null, 2) + '\n');
  w(join(repo, 'CLAUDE.md'), '# Reglas\n- JavaScript ESM, sin comentarios en el codigo.\n- Tests con node:test en test/*.test.js.\n- Texto y mensajes para el usuario en espanol.\n');
  w(join(repo, 'src', 'api', 'client.js'), `const BASE = 'https://api.example.test';

export async function get(path, fetchImpl = fetch) {
  const res = await fetchImpl(BASE + path);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

export async function post(path, body, fetchImpl = fetch) {
  const res = await fetchImpl(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
`);
  w(join(repo, 'src', 'screens', 'login.js'), `import { post } from '../api/client.js';

export async function login(user, pass) {
  const session = await post('/login', { user, pass });
  return session.token;
}
`);
  w(join(repo, 'test', 'client.test.js'), `import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from '../src/api/client.js';

test('get devuelve el json', async () => {
  const fake = async () => ({ ok: true, json: async () => ({ a: 1 }) });
  assert.deepEqual(await get('/x', fake), { a: 1 });
});

test('get falla con HTTP 500', async () => {
  const fake = async () => ({ ok: false, status: 500 });
  await assert.rejects(() => get('/x', fake), /HTTP 500/);
});
`);
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'tester');
  git('add', '-A');
  git('commit', '-qm', 'init');
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.orchestrator/\n');
}

function seedState(state) {
  mkdirSync(state, { recursive: true });
  const real = join(homedir(), '.claude', 'orchestrator');
  for (const f of ['catalog.json', 'quota-cache.json']) {
    if (existsSync(join(real, f))) copyFileSync(join(real, f), join(state, f));
  }
}

const now = new Date().toISOString();

function finishedRun(repo, { planId, runId, meta, exitCode, result, stderr }) {
  const dir = join(repo, '.orchestrator', 'runs', runId);
  w(join(dir, 'packet.md'), `# IMPLEMENTATION PACKET ${runId}\nPLAN_PATH: ${join(repo, '.orchestrator', 'plans', planId + '.md')}\n`);
  w(join(dir, 'status.json'), JSON.stringify({
    state: 'exited', pid: 1, startedAt: now, heartbeatAt: now, endedAt: now, exitCode, signal: null,
    meta: { runId, planId, planPath: join(repo, '.orchestrator', 'plans', planId + '.md'), permission: 'smart', heartbeatMs: 30000, ...meta },
  }, null, 2));
  w(join(dir, 'snapshot.json'), JSON.stringify({ porcelain: '' }));
  w(join(dir, 'stdout.log'), '');
  w(join(dir, 'stderr.log'), stderr ?? '');
  if (result) w(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  w(join(dir, 'events.jsonl'), JSON.stringify({ ts: now, type: 'launch', runId }) + '\n');
  w(join(repo, '.orchestrator', 'lock'), JSON.stringify({ planId, runId, pid: null, createdAt: now, updatedAt: now }));
}

const EVALS = {
  'plan-and-route': (repo) => {
    baseRepo(repo);
  },
  'plan-contradiction-no-fallback': (repo) => {
    baseRepo(repo);
    w(join(repo, '.orchestrator', 'plans', 'add-retry.md'), `# Plan add-retry: reintentos en el cliente HTTP
Class: SMALL_FIX · Estimated files: 2

## Context
Agregar reintento automatico (2 veces) cuando una peticion falla con HTTP 503.

## Current state (verified)
- src/api/http.js exporta request(url, options) y todas las llamadas pasan por ahi.

## Scope
- In scope: src/api/http.js, test/http.test.js
- Out of scope: todo lo demas

## Steps
1. En src/api/http.js, hacer que request() reintente hasta 2 veces ante HTTP 503 · files: src/api/http.js · symbols: request
2. Agregar un test del reintento · files: test/http.test.js

## Validation
- Commands: \`npm test\`
- Done when: npm test pasa y el test nuevo cubre el reintento
`);
    finishedRun(repo, {
      planId: 'add-retry',
      runId: 'add-retry-20261012T100000',
      meta: { harness: 'devin', model: 'devin/gpt-6-1-sol', effort: 'medium', klass: 'SMALL_FIX' },
      exitCode: 0,
      result: {
        status: 'PLAN_CONTRADICTION',
        summary: 'El plan asume src/api/http.js con request(); no existe. El cliente real esta en src/api/client.js con get() y post().',
        modifiedFiles: [],
        planStepsCompleted: [],
        validation: [],
        planContradiction: {
          section: 'Current state (verified)',
          planAssumption: 'src/api/http.js exporta request(url, options)',
          reality: 'No existe src/api/http.js; src/api/client.js exporta get(path) y post(path, body)',
          files: ['src/api/client.js'],
          symbols: ['get', 'post'],
          lines: ['src/api/client.js:3', 'src/api/client.js:9'],
          evidence: 'ls src/api -> client.js; grep -rn "request(" src -> sin resultados',
          impact: 'Los pasos 1 y 2 apuntan a archivos y simbolos inexistentes',
          affectedSteps: ['1', '2'],
          changesMadeBefore: [],
        },
        errors: [],
      },
    });
  },
  'quota-fallback-before-work': (repo) => {
    baseRepo(repo);
    w(join(repo, '.orchestrator', 'plans', 'user-search.md'), `# Plan user-search: busqueda de usuarios
Class: FEATURE · Estimated files: 3

## Context
Agregar src/api/users.js con searchUsers(query) que llame GET /users?q=<query>, y un test.

## Current state (verified)
- src/api/client.js exporta get(path, fetchImpl) (linea 3).

## Scope
- In scope: src/api/users.js, test/users.test.js
- Out of scope: todo lo demas

## Steps
1. Crear src/api/users.js con searchUsers(query) que use get() de client.js · files: src/api/users.js
2. Crear test/users.test.js con un fetch falso · files: test/users.test.js

## Validation
- Commands: \`npm test\`
- Done when: npm test pasa
`);
    finishedRun(repo, {
      planId: 'user-search',
      runId: 'user-search-20261012T101500',
      meta: { harness: 'codex', model: 'codex/gpt-6.1-sol', effort: 'medium', klass: 'FEATURE', permission: null },
      exitCode: 1,
      result: null,
      stderr: "ERROR: You've hit your usage limit. Try again later.\n",
    });
  },
};

const made = [];
for (const [name, build] of Object.entries(EVALS)) {
  for (const cfg of CONFIGS) {
    const base = join(outDir, name, cfg);
    const repo = join(base, 'repo');
    const state = join(base, 'state');
    mkdirSync(join(base, 'outputs'), { recursive: true });
    build(repo);
    seedState(state);
    made.push({ eval: name, config: cfg, repo, state, outputs: join(base, 'outputs') });
  }
}
console.log(JSON.stringify(made, null, 2));
