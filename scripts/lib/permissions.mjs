import { readFileSync } from 'node:fs';
import { parsePlanValidation } from './validate.mjs';

const REJECTED = /rejected by the user|requires confirmation/i;
const SPLIT = /\s*(?:&&|\|\||;|\||\r?\n)\s*/;
const SYSTEM_COMMANDS = 'rm|rmdir|rd|del|erase|rimraf|shred|truncate|dd|mkfs|format|diskpart|shutdown|reboot|taskkill|kill|pkill|sudo|chmod|chown|icacls|attrib|reg|regedit|setx|schtasks|sc';
const VETOES = [
  [new RegExp(`(^|[\\s;&|(])(${SYSTEM_COMMANDS})(\\s|$)`, 'i'), 'destructive or system-level command'],
  [/\b(Remove-Item|Clear-Content|Set-ExecutionPolicy|Stop-Process|Invoke-Expression|iex)\b/i, 'destructive or system-level PowerShell command'],
  [/(^|[\s;&|(])git\s+(?!(status|diff|log|show|rev-parse|ls-files|blame|describe)\b)/i, 'git command that can change the repository'],
  [/\b(npm|pnpm|yarn)\s+(publish|config|set|login|logout|adduser|token|owner|access|unpublish|deprecate)\b/i, 'package manager command that changes global or registry state'],
  [/\s(-g|--global)(\s|$)|--location[= ]global/i, 'global install or global configuration'],
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sh|bash|zsh|iex|powershell|pwsh|node)\b/i, 'downloads and runs code'],
  [/(^|[\s"'=/\\])\.git([/\\]|\s|$|["'])/, 'touches .git'],
  [/\.(npmrc|gitconfig|ssh)\b|[/\\]\.claude[/\\]|[/\\]\.devin[/\\]|^\.devin[/\\]/i, 'touches user or tool configuration'],
  [/(^|[\s"'=])\.\.([/\\]|\s|$|["'])/, 'leaves the workspace (..)'],
  [/(^|[\s"'=])~([/\\]|\s|$)|%[A-Za-z_]+%|\$HOME|\$env:|\$\{?(HOME|USERPROFILE)/i, 'leaves the workspace (home or environment path)'],
];
const ABSOLUTE = /(?:^|[\s"'=])([A-Za-z]:[\\/][^\s"']*|\/(?!\/)[^\s"']*)/g;

const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const clean = (s) => s.trim().replace(/\s+/g, ' ');

function planCommands(planText) {
  const spans = [...planText.matchAll(/`([^`\n]{3,})`/g)].map((m) => clean(m[1]));
  return [...new Set([...spans, ...parsePlanValidation(planText).map(clean)])];
}

function insideRepo(token, repo) {
  if (!repo) return false;
  const t = norm(token);
  const r = norm(repo);
  return t === r || t.startsWith(`${r}/`);
}

function vetoOf(text, { forbidden, repo }) {
  const lower = text.toLowerCase();
  for (const f of forbidden) if (f && lower.includes(f.toLowerCase())) return `matches the forbidden command "${f}"`;
  for (const [re, why] of VETOES) if (re.test(text)) return why;
  for (const m of text.matchAll(ABSOLUTE)) if (!insideRepo(m[1], repo)) return 'leaves the workspace (absolute path)';
  return null;
}

function covered(segment, known) {
  return known.some((k) => segment === k || segment.startsWith(`${k} `));
}

function assessCommand(command, ctx) {
  const whole = clean(command);
  const veto = vetoOf(whole, ctx);
  const segments = whole.split(SPLIT).map(clean).filter(Boolean);
  if (veto) return { verdict: 'stop', reason: veto, segments };
  for (const seg of segments) {
    const segVeto = vetoOf(seg, ctx);
    if (segVeto) return { verdict: 'stop', reason: segVeto, segments };
  }
  const missing = segments.find((s) => !covered(s, ctx.known));
  if (missing) return { verdict: 'unknown', reason: `"${missing}" is not named in the plan`, segments };
  return { verdict: 'allow', reason: 'named in the plan and not destructive', segments };
}

export function assessBlockedCalls({ calls = [], planText = '', forbidden = [], repo = '' }) {
  if (!calls.length) return { safe: false, calls: [], allowExec: [], reason: 'The rejected tool calls could not be inspected' };
  const ctx = { forbidden, repo, known: planCommands(planText) };
  const out = calls.map((c) => {
    if (c.tool !== 'exec' || typeof c.command !== 'string' || !c.command.trim()) {
      return { tool: c.tool, command: c.command ?? null, verdict: 'unknown', reason: `blocked tool "${c.tool}" is not a shell command`, segments: [] };
    }
    const a = assessCommand(c.command, ctx);
    return { tool: c.tool, command: c.command, verdict: a.verdict, reason: a.reason, segments: a.segments };
  });
  const safe = out.every((c) => c.verdict === 'allow');
  const allowExec = safe ? [...new Set(out.flatMap((c) => c.segments))] : [];
  const worst = out.find((c) => c.verdict === 'stop') ?? out.find((c) => c.verdict === 'unknown');
  return {
    safe,
    calls: out.map(({ segments: _s, ...rest }) => rest),
    allowExec,
    reason: safe ? 'every rejected call is named in the plan and not destructive' : `${worst.command ?? worst.tool}: ${worst.reason}`,
  };
}

export function parseDevinExport(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { found: false, rejected: [] };
  }
  const rejected = [];
  for (const step of Array.isArray(data?.steps) ? data.steps : []) {
    const calls = new Map((step.tool_calls ?? []).map((c) => [c.tool_call_id, c]));
    for (const res of step.observation?.results ?? []) {
      if (!REJECTED.test(String(res.content ?? ''))) continue;
      const call = calls.get(res.source_call_id);
      if (!call) continue;
      const command = call.arguments?.command;
      rejected.push({ tool: call.function_name, command: typeof command === 'string' ? command : null });
    }
  }
  const usage = {};
  for (const [key, field] of [['promptTokens', 'total_prompt_tokens'], ['completionTokens', 'total_completion_tokens'], ['cachedTokens', 'total_cached_tokens']]) {
    const value = data?.final_metrics?.[field];
    if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return { found: true, rejected, ...(Object.keys(usage).length ? { usage: { source: 'devin-export', ...usage } } : {}) };
}
