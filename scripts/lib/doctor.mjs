import { arch, platform, release } from 'node:os';
import { resolveExecutable } from './platform.mjs';

export const VERIFIED_VERSIONS = { claude: '2.1.296', devin: '3000.11.3', codex: '0.160.0', agy: '1.3.3' };
export const ROLE_GUARD_MIN_CLAUDE = '2.1.295';

const AUTH_COMMANDS = {
  claude: ['auth', 'status'],
  devin: ['auth', 'status'],
  codex: ['login', 'status'],
};

const PENDING = [
  ['P1', 'devin -p "/usage" resolved by the CLI without spending a turn'],
  ['P2', 'Location of Devin credentials on Windows and macOS'],
  ['P3', 'Shape of the GetUserStatus call'],
  ['P4', 'codex exec resume <thread_id> works with stdin'],
  ['P5', 'Monitor available in Claude Desktop'],
  ['P6', 'Devin stderr patterns for quota, rate limit and model unavailable'],
  ['P7', 'Live macOS runs with workers and Claude Desktop'],
  ['P8', 'Statusline runs in Claude Desktop'],
].map(([id, title]) => ({ id, title, status: 'unverified' }));

const versionOf = (text) => /(\d+\.\d+\.\d+)/.exec(text ?? '')?.[1] ?? null;

function sessionKind(env) {
  if (env.CLAUDE_CODE_REMOTE === 'true') return 'cloud';
  if (/desktop/i.test(env.CLAUDE_CODE_ENTRYPOINT ?? '')) return 'desktop';
  return 'local';
}

export async function runDoctor({ run, paths, env = process.env, catalog = null, now = new Date(), overrides = {} }) {
  const warnings = [];
  const resolved =
    paths ?? Object.fromEntries(Object.keys(VERIFIED_VERSIONS).map((n) => [n, resolveExecutable(n, { env, overrides })]));

  const clis = {};
  for (const name of Object.keys(VERIFIED_VERSIONS)) {
    const exe = resolved[name];
    if (!exe) {
      clis[name] = { found: false, path: null, version: null, auth: 'unknown' };
      warnings.push(`${name} not found`);
      continue;
    }
    const v = await run(exe, ['--version']);
    const version = v.status === 0 ? versionOf(v.stdout) : null;
    if (version && version !== VERIFIED_VERSIONS[name]) {
      warnings.push(`${name} version ${version} differs from verified ${VERIFIED_VERSIONS[name]}`);
    }
    let auth = 'unverified';
    if (AUTH_COMMANDS[name]) {
      const a = await run(exe, AUTH_COMMANDS[name]);
      auth = a.status === 0 ? 'ok' : 'failed';
      if (a.status === 0 && name === 'claude') {
        try {
          auth = JSON.parse(a.stdout).loggedIn === true ? 'ok' : 'failed';
        } catch {
          auth = 'unverified';
        }
      }
    }
    clis[name] = { found: true, path: exe, version, auth };
  }

  const workers = {};
  for (const name of ['devin', 'codex', 'agy']) workers[name] = clis[name].found && clis[name].auth !== 'failed';

  const git = await run('git', ['--version']);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const session = { kind: sessionKind(env) };

  const age = catalog?.generatedAt ? Math.floor((now - new Date(catalog.generatedAt)) / 86400000) : null;
  const versionParts = (clis.claude.version ?? '').split('.').map(Number);
  const roleGuard = { available: versionParts.length === 3 && (versionParts[0] > 2 || (versionParts[0] === 2 && (versionParts[1] > 1 || (versionParts[1] === 1 && versionParts[2] >= 295)))), minimumClaude: ROLE_GUARD_MIN_CLAUDE };
  if (!roleGuard.available) warnings.push(`Claude Code >= ${ROLE_GUARD_MIN_CLAUDE} is required for the Tech Lead role guard with failure blocking`);

  const ok = session.kind !== 'cloud' && git.status === 0 && nodeMajor >= 20
    && clis.claude.found && clis.claude.auth === 'ok' && roleGuard.available && Object.values(workers).some(Boolean);

  return {
    ok,
    os: { platform: platform(), release: release(), arch: arch() },
    node: process.version,
    git: git.status === 0 ? versionOf(git.stdout) : null,
    session,
    clis,
    workers,
    roleGuard,
    catalog: catalog
      ? { present: true, ageDays: age, models: catalog.models?.length ?? 0 }
      : { present: false, ageDays: null, models: 0 },
    quota: {
      codex: 'official (app-server)',
      claude: 'statusline (not installed)',
      devin: 'unofficial (GetUserStatus)',
      agy: 'none (reactive only)',
    },
    pending: PENDING,
    warnings,
  };
}
