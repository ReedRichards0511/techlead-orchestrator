import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlanValidation } from './validate.mjs';
import { writeJson } from './config.mjs';

const runner = realpathSync(fileURLToPath(new URL('../orch.mjs', import.meta.url)));
const runnerCommands = new Set(['doctor', 'models', 'quota', 'route', 'check-plan', 'preflight', 'run', 'status', 'wait', 'postflight', 'history', 'bootstrap', 'unlock', 'usage', 'go', 'close']);
const readCommands = new Set(['rg', 'grep', 'cat', 'head', 'tail', 'ls', 'pwd', 'wc', 'file', 'stat', 'which', 'command', 'Get-Content', 'Get-ChildItem', 'Get-Item', 'Test-Path', 'Get-Command', 'Select-String', 'Select-Object']);
const inside = (root, path) => { const rel = relative(root, path); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };

export function activeTechLead(cwd, session) {
  if (!cwd || !session) return null;
  for (let repo = resolve(cwd); ; repo = dirname(repo)) {
    const dir = join(repo, '.orchestrator', 'usage');
    try {
      const tasks = [];
      for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        let task; try { task = JSON.parse(readFileSync(join(dir, file), 'utf8')); } catch { continue; }
        if (task.session === session && task.startedAt) tasks.push({ ...task, marker: join(dir, file) });
      }
      const latest = tasks.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
      if (latest) return latest.roleActive === true || (!latest.report && latest.roleActive !== false) ? { ...latest, repo } : null;
    } catch {}
    if (dirname(repo) === repo) return null;
  }
}

export function closeTechLead(input) {
  const active = activeTechLead(input.cwd, input.session_id);
  if (!active?.report) return false;
  const { repo: _repo, marker, ...task } = active;
  writeJson(marker, { ...task, roleActive: false });
  return true;
}

function shellCommands(command) {
  if (typeof command !== 'string' || /[$`]/.test(command)) return null;
  command = command.replace(/\b[12]?>&[12]\b/g, '');
  const commands = [];
  let words = [], word = '', quote = null;
  const flushWord = () => { if (word) words.push(word); word = ''; };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && command[i + 1] === '"') word += command[++i];
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if ('<>'.includes(char)) return null;
    else if (char === ';' || char === '\n' || char === '|' || char === '&') {
      if (char === '&' && command[i + 1] !== '&') return null;
      if (command[i + 1] === char) i++;
      flushCommand();
    } else if (/\s/.test(char)) flushWord();
    else word += char;
  }
  if (quote) return null;
  flushCommand();
  return commands;
}

function pathOf(value, cwd) {
  return resolve(cwd, value.startsWith('~/') || value.startsWith('~\\') ? join(homedir(), value.slice(2)) : value);
}

function readOnly(words, cwd, active, validations) {
  const [exe, ...args] = words;
  if (['rm', 'mv', 'cp', 'touch', 'mkdir', 'rmdir', 'Remove-Item', 'Move-Item', 'Copy-Item', 'Set-Content', 'Add-Content'].includes(exe)) return false;
  if (basename(exe).replace(/\.exe$/i, '') === 'node' && (args.includes('worker-files') || args.some(a => ['-e', '--eval', '-p', '--print', '-'].includes(a)))) return false;
  if (validations.some(v => JSON.stringify(v) === JSON.stringify(words))) return true;
  if (exe === 'cd' || exe === 'Set-Location') {
    const paths = exe === 'Set-Location' && ['-LiteralPath', '-Path'].includes(args[0]) ? args.slice(1) : args;
    return paths.length === 1 && inside(active.repo, pathOf(paths[0], cwd));
  }
  if (readCommands.has(exe)) return !args.some(a => /^(?:--(?:pre|output|output-file)(?:=|$)|-(?:exec|execdir|delete|EncodedCommand|Command|ScriptBlock)$)/.test(a)) && (!/^(?:Get-|Select-|Test-)/.test(exe) || !args.some(a => /[{}]/.test(a)));
  if (exe === 'sed') return args.length >= 2 && args[0] === '-n' && /^\d+(?:,\d+)?p$/.test(args[1]) && !args.slice(2).some(a => a.startsWith('-'));
  if (exe === 'git') {
    let index = 0;
    if (args[0] === '-C') index = 2;
    return ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe'].includes(args[index]) && !args.some(a => /^--(?:output|ext-diff|textconv|exec-path)(?:=|$)/.test(a));
  }
  if (basename(exe).replace(/\.exe$/i, '') === 'node') {
    if (args.length === 1 && ['-v', '--version'].includes(args[0])) return true;
    try {
      return realpathSync(pathOf(args[0], cwd)) === runner && runnerCommands.has(args[1]);
    } catch { return false; }
  }
  return false;
}

function artifactWrite(path, cwd, repo) {
  if (typeof path !== 'string') return false;
  const full = pathOf(path, cwd);
  const relativePath = relative(repo, full).split(sep).join('/');
  if (!/^\.orchestrator\/(?:plans\/[^/]+\.(?:md|json)|runs\/[a-zA-Z0-9_-]+\/audit\.md)$/.test(relativePath)) return false;
  let cursor = resolve(repo);
  for (const part of relativePath.split('/')) {
    cursor = join(cursor, part);
    let stat; try { stat = lstatSync(cursor); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) return false;
  }
  return true;
}

export function guardTechLead(input) {
  const active = activeTechLead(input.cwd, input.session_id);
  if (!active) return null;
  const tool = input.tool_name;
  const data = input.tool_input ?? {};
  let allowed = true;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) allowed = artifactWrite(data.file_path ?? data.notebook_path, input.cwd, active.repo);
  if (['Bash', 'PowerShell'].includes(tool)) {
    const commands = shellCommands(data.command);
    let validations = [];
    try { validations = parsePlanValidation(readFileSync(active.planPath, 'utf8')).flatMap(c => shellCommands(c) ?? []); } catch {}
    allowed = Boolean(commands?.length) && commands.every(words => readOnly(words, input.cwd, active, validations));
  }
  if (allowed) return null;
  return { hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'Orchestrator Tech Lead is read-only for project files. Use Read/Glob/Grep, the runner or declared validation commands. Write only plans, repair/continuation JSON and audit.md. Delegate all source, tests, docs and file operations to the selected worker; do not rescue a blocked implementation yourself.',
  } };
}
