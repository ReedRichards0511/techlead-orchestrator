import { capture } from './proc.mjs';
import { isWindows } from './platform.mjs';

function section(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

const stripTicks = (s) => s.replace(/`/g, '').trim();

export function parsePlanValidation(text) {
  const lines = section(text, 'Validation');
  const commands = [];
  let collecting = false;
  for (const line of lines) {
    const top = /^[-*]\s*Commands?\s*:\s*(.*)$/i.exec(line);
    if (top) {
      collecting = true;
      const rest = top[1].trim();
      if (!rest) continue;
      const ticked = [...rest.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
      if (ticked.length) commands.push(...ticked);
      else commands.push(...rest.split(';').map((s) => s.trim()).filter(Boolean));
      collecting = false;
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      collecting = false;
      continue;
    }
    const sub = /^\s+[-*]\s+(.*)$/.exec(line);
    if (collecting && sub) {
      const ticked = /`([^`]+)`/.exec(sub[1]);
      commands.push((ticked ? ticked[1] : sub[1]).trim());
    }
  }
  return commands;
}

export function parseScope(text) {
  const lines = section(text, 'Scope');
  const result = { inScope: [], outOfScope: [] };
  let current = null;
  for (const line of lines) {
    const top = /^[-*]\s*(In scope|Out of scope)\s*:\s*(.*)$/i.exec(line);
    if (top) {
      current = /^in/i.test(top[1]) ? result.inScope : result.outOfScope;
      current.push(...top[2].split(',').map(stripTicks).filter(Boolean));
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      current = null;
      continue;
    }
    const sub = /^\s+[-*]\s+(.*)$/.exec(line);
    if (current && sub) current.push(stripTicks(sub[1]));
  }
  return result;
}

export function validatePlan(text) {
  const errors = [];
  if (!parseScope(text).inScope.length) errors.push('Plan needs ## Scope with a non-empty - In scope: list');
  if (!parsePlanValidation(text).length) errors.push('Plan needs ## Validation with non-empty - Commands:');
  return { ok: errors.length === 0, errors };
}

const normalize = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

function globToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchScope(path, patterns) {
  const p = normalize(path);
  for (const raw of patterns) {
    const pat = normalize(raw);
    if (!pat) continue;
    if (pat.endsWith('/')) {
      if (p.startsWith(pat)) return true;
      continue;
    }
    if (p === pat) return true;
    if (/[*?]/.test(pat)) {
      if (globToRegex(pat).test(p)) return true;
    } else if (p.startsWith(`${pat}/`)) return true;
  }
  return false;
}

export async function runValidation({ repo, commands, forbidden = [], timeoutMs = 600000 }) {
  const results = [];
  for (const command of commands) {
    if (forbidden.some((f) => command.includes(f))) {
      results.push({ command, exitCode: null, passed: false, blocked: true, timedOut: false, tail: 'blocked by forbiddenCommands' });
      continue;
    }
    const r = isWindows
      ? await capture('cmd.exe', ['/d', '/s', '/c', `"${command}"`], { cwd: repo, timeoutMs, verbatim: true })
      : await capture('sh', ['-c', command], { cwd: repo, timeoutMs });
    const tail = `${r.stdout}${r.stderr}`.slice(-2000);
    results.push({
      command,
      exitCode: r.status,
      passed: r.status === 0 && !r.timedOut,
      timedOut: Boolean(r.timedOut),
      tail,
    });
  }
  return results;
}

export function compareToBaseline(baseline, current) {
  const byCommand = new Map((baseline ?? []).map((b) => [b.command, b]));
  const out = { regressions: [], preexisting: [], fixed: [] };
  for (const c of current) {
    const b = byCommand.get(c.command);
    if (!b) {
      if (!c.passed) out.regressions.push({ command: c.command, reason: 'new command failing' });
    } else if (b.passed && !c.passed) out.regressions.push({ command: c.command, reason: 'passed at baseline, fails now' });
    else if (!b.passed && !c.passed) out.preexisting.push({ command: c.command });
    else if (!b.passed && c.passed) out.fixed.push({ command: c.command });
  }
  return out;
}
