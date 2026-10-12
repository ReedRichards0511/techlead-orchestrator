import { join } from 'node:path';
import { loadConfig } from '../config.mjs';
import { resolveExecutable } from '../platform.mjs';
import { PROVIDERS, formatDashboard, getAllQuotas, markExhausted, setManual } from '../quota/index.mjs';
import { fetchCodexQuota } from '../quota/codex.mjs';
import { readClaudeUsage } from '../quota/claude.mjs';

function parsePercent(arg, name) {
  const m = new RegExp(`^${name}=(\\d+(?:\\.\\d+)?)$`).exec(arg);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (n < 0 || n > 100) throw new Error(`${name} must be between 0 and 100`);
  return n;
}

export async function main(args, ctx) {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const [sub, provider, ...kv] = rest;
  const config = loadConfig({ stateDir: ctx.stateDir });
  const now = new Date();

  if (sub === 'set') {
    if (!PROVIDERS.includes(provider)) {
      console.error(`Unknown provider: ${provider}. Use one of: ${PROVIDERS.join(', ')}`);
      return 2;
    }
    try {
      const daily = kv.map((a) => parsePercent(a, 'daily')).find((v) => v !== undefined);
      const weekly = kv.map((a) => parsePercent(a, 'weekly')).find((v) => v !== undefined);
      if (daily === undefined && weekly === undefined) {
        console.error('Usage: orch quota set <provider> daily=N weekly=N (percent remaining)');
        return 2;
      }
      setManual({ stateDir: ctx.stateDir, provider, daily, weekly, now, config });
      console.log(`manual quota stored for ${provider} (marked STALE)`);
      return 0;
    } catch (e) {
      console.error(e.message);
      return 2;
    }
  }

  if (sub === 'exhausted') {
    if (!PROVIDERS.includes(provider)) {
      console.error(`Unknown provider: ${provider}`);
      return 2;
    }
    markExhausted({ stateDir: ctx.stateDir, provider, now });
    console.log(`${provider} marked EXHAUSTED (reactive)`);
    return 0;
  }

  if (sub !== undefined && sub !== 'refresh') {
    console.error(`Unknown quota subcommand: ${sub}`);
    return 2;
  }

  const overrides = config.platformOverrides?.paths ?? {};
  const codexExe = resolveExecutable('codex', { overrides });
  const deps = {
    fetchCodex: (o) => (codexExe ? fetchCodexQuota({ exe: codexExe, ...o }) : Promise.reject(new Error('codex not found'))),
    readClaude: (o) => readClaudeUsage({ file: join(ctx.stateDir, 'claude-usage.json'), ...o }),
    fetchDevin: null,
  };
  const all = await getAllQuotas({ stateDir: ctx.stateDir, config, now, deps, refresh: sub === 'refresh' });
  console.log(json ? JSON.stringify(all, null, 2) : formatDashboard(all, config));
  return 0;
}
