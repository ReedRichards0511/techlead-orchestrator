import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './config.mjs';
import { matchScope, parseScope } from './validate.mjs';

const runner = fileURLToPath(new URL('../orch.mjs', import.meta.url));
const ledgerPath = (repo, planId) => join(repo, '.orchestrator', 'snapshots', planId, 'file-operations.json');
export const hasFileOperationBaseline = (repo, planId) => existsSync(ledgerPath(repo, planId));

export function parseFileOperations(text) {
  const body = /^## File operations\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/mi.exec(text)?.[1] ?? '';
  const operations = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[-*]\s*(none|ninguna)\b/i.test(line)) continue;
    const move = /^\s*[-*]\s*Move:\s*`([^`]+)`\s*->\s*`([^`]+)`\s*$/i.exec(line);
    const deletion = /^\s*[-*]\s*Delete:\s*`([^`]+)`\s*$/i.exec(line);
    if (move) operations.push({ kind: 'move', source: move[1], destination: move[2] });
    else if (deletion) operations.push({ kind: 'delete', source: deletion[1] });
    else throw new Error(`Invalid File operations entry: ${line.trim()}; use Move: \`source\` -> \`destination\` or Delete: \`path\``);
  }
  return operations;
}

function checkedPath(repo, path) {
  if (!path || isAbsolute(path) || /^[A-Za-z]:|^[\\/]/.test(path)) throw new Error('File operations require workspace-relative paths');
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.some(p => ['..', '.git', '.orchestrator', '.devin', '.claude'].includes(p.toLowerCase())) || /[*?{}]/.test(path)) throw new Error(`Unsafe file operation path: ${path}`);
  const root = realpathSync(repo);
  const full = resolve(root, ...parts);
  const rel = relative(root, full);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`File operation leaves the workspace: ${path}`);
  let cursor = root;
  for (const part of rel.split(sep)) {
    cursor = join(cursor, part);
    let stat; try { stat = lstatSync(cursor); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat?.isSymbolicLink()) throw new Error(`File operations cannot follow symlinks: ${path}`);
  }
  return full;
}

export function checkFileOperations({ repo, planText }) {
  const operations = parseFileOperations(planText);
  const scope = parseScope(planText);
  const touched = new Set();
  for (const op of operations) {
    for (const path of [op.source, op.destination].filter(Boolean)) {
      checkedPath(repo, path);
      if (!matchScope(path, scope.inScope) || matchScope(path, scope.outOfScope)) throw new Error(`File operation is outside the plan scope: ${path}`);
      if (touched.has(path)) throw new Error(`File operation path appears more than once: ${path}`);
      touched.add(path);
    }
    const source = checkedPath(repo, op.source);
    if (!existsSync(source) || !lstatSync(source).isFile()) throw new Error(`File operation source must be an existing regular file: ${op.source}`);
    if (op.destination && existsSync(checkedPath(repo, op.destination))) throw new Error(`File operation destination already exists: ${op.destination}`);
  }
  return operations;
}

export function prepareFileOperations({ repo, planId, operations }) {
  if (!operations.length) return;
  const path = ledgerPath(repo, planId);
  mkdirSync(dirname(path), { recursive: true });
  const prepared = operations.map((op, index) => {
    const backup = join(dirname(path), `file-operation-${index + 1}.backup`);
    copyFileSync(checkedPath(repo, op.source), backup, constants.COPYFILE_EXCL);
    return { ...op, backup, done: false };
  });
  writeJson(path, { repo: resolve(repo), planId, operations: prepared });
}

export function fileOperationCommands({ repo, planId, runId, planText }) {
  const operations = parseFileOperations(planText);
  if (!operations.length) return [];
  const ledger = readJson(ledgerPath(repo, planId));
  if (!ledger || operations.some((op, i) => op.kind !== ledger.operations[i]?.kind || op.source !== ledger.operations[i]?.source || op.destination !== ledger.operations[i]?.destination) || operations.length !== ledger.operations.length) throw new Error('File operations have no matching preflight backup; run preflight before launching');
  // Shell quoting is shared by Bash and PowerShell; reject expansion characters in executable paths.
  if (/["$`\r\n]/.test(runner + repo + runId)) throw new Error('Cannot safely quote this file-operation command path');
  return operations.map((_, index) => `node "${runner}" worker-files --repo "${repo}" --run ${runId} --operation ${index + 1}`);
}

export function applyFileOperation({ repo, runId, operation }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId ?? '') || !Number.isSafeInteger(operation) || operation < 1) throw new Error('Invalid worker file-operation request');
  const status = readJson(join(repo, '.orchestrator', 'runs', runId, 'status.json'));
  const lock = readJson(join(repo, '.orchestrator', 'lock'));
  if (status?.state !== 'running' || lock?.runId !== runId || lock.planId !== status.meta?.planId) throw new Error('File operations require the active worker run and its writer lock');
  const path = ledgerPath(repo, status.meta.planId);
  const ledger = readJson(path);
  const op = ledger?.operations?.[operation - 1];
  if (!op || ledger.repo !== resolve(repo)) throw new Error('File operation is not declared for this run');
  const planText = readFileSync(status.meta.planPath, 'utf8');
  const declared = parseFileOperations(planText)[operation - 1];
  if (!declared || declared.kind !== op.kind || declared.source !== op.source || declared.destination !== op.destination) throw new Error('File operations changed after preflight');
  const scope = parseScope(planText);
  if ([op.source, op.destination].filter(Boolean).some(path => !matchScope(path, scope.inScope) || matchScope(path, scope.outOfScope))) throw new Error('File operation is outside the current plan scope');
  const source = checkedPath(repo, op.source);
  const destination = op.destination ? checkedPath(repo, op.destination) : null;
  if (op.done) {
    if (existsSync(source) || (destination && !existsSync(destination))) throw new Error('Previously completed file operation no longer matches the tree');
    return { operation, alreadyApplied: true, kind: op.kind };
  }
  if (!existsSync(op.backup) || !existsSync(source) || !lstatSync(source).isFile()) throw new Error('File operation requires its preflight backup and a regular source file');
  if (destination) {
    if (existsSync(destination)) throw new Error('Refusing to overwrite the file-operation destination');
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  unlinkSync(source);
  op.done = true;
  writeJson(path, ledger);
  return { operation, kind: op.kind, source: op.source, ...(op.destination ? { destination: op.destination } : {}) };
}
