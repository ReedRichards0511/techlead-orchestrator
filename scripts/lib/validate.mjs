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

function scopePaths(value) {
  const parts = [];
  let start = 0, depth = 0, quoted = false;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '`') quoted = !quoted;
    if (!quoted && value[i] === '{') depth++;
    if (!quoted && value[i] === '}') depth--;
    if (value[i] === ',' && !quoted && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start));
  let expanded = 0;
  const expand = path => {
    const brace = /\{([^{}]+)\}/.exec(path);
    if (!brace && ++expanded > 256) throw new Error('Scope brace expansion exceeds 256 paths; use one path per line');
    return brace ? brace[1].split(',').flatMap(item => expand(path.replace(brace[0], item.trim()))) : [path];
  };
  return parts.flatMap(part => {
    const path = stripTicks(part).replace(/\s+\((?:eliminar|delete|remove|mover|move)\)\s*$/i, '');
    if ((path.match(/\{/g) ?? []).length > 4) throw new Error('Scope has too many nested brace expansions; use one path per line');
    const paths = path ? expand(path) : [];
    if (paths.length > 256) throw new Error('Scope brace expansion exceeds 256 paths; use one path per line');
    return paths;
  });
}

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
      current.push(...scopePaths(top[2]));
      continue;
    }
    if (/^[-*]\s/.test(line)) {
      current = null;
      continue;
    }
    const sub = /^\s+[-*]\s+(.*)$/.exec(line);
    if (current && sub) current.push(...scopePaths(sub[1]));
  }
  return result;
}

export function validatePlan(text) {
  const errors = [];
  if (!parseScope(text).inScope.length) errors.push('Plan needs ## Scope with a non-empty - In scope: list');
  if (!parsePlanValidation(text).length) errors.push('Plan needs ## Validation with non-empty - Commands:');
  const conflict = text.split(/\r?\n/).find(line => !/\b(do not|don't|never|no|sin)\s+(add|new|añad\w*|agreg\w*|crea\w*|comentarios|comments)/i.test(line)
    && /\/\/|\/\*|\bJSDoc\b|\bdocstring\b|\binline\s+comments?\b|\bcomments?\s+(?:in|to)\s+(?:the\s+)?code\b|\bcomentarios?\s+(?:en|de)\s+(?:el\s+)?código\b/i.test(line)
    && /\b(add|new|añad\w*|agreg\w*|crea\w*|incluir)\b.{0,80}\b(comment\w*|comentario\w*|TODO|FIXME)\b/i.test(line));
  const literal = conflict ? null : commentLiteral(text);
  if (conflict || literal) errors.push(`Plan conflicts with NO_COMMENTS_POLICY: ${(conflict ?? literal).trim()}`);
  return { ok: errors.length === 0, errors };
}

// A quoted comment such as `// TODO(nav): ...` outside Current state asks the worker to write it, unless the line refers to an existing one.
function commentLiteral(text) {
  let current = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { current = /^##\s+Current state/i.test(line); continue; }
    if (current || !/`\s*\{?\s*(?:\/\/|\/\*)/.test(line)) continue;
    if (/\b(existing|existente\w*|actual\w*|update\w*|keep|conserv\w*|manten\w*|mantien\w*|preserv\w*|remove\w*|quit\w*|elimin\w*|borr\w*|do not|don't|never|no|sin)\b/i.test(line.replace(/`[^`]*`/g, ''))) continue;
    return line;
  }
  return null;
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
