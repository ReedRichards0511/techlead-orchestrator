import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { isAlive } from './proc.mjs';
import { compareToBaseline, matchScope, parsePlanValidation, parseScope, runValidation } from './validate.mjs';

void compareToBaseline;

const MANIFEST_NAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock',
  'Podfile', 'Podfile.lock', 'Gemfile', 'Gemfile.lock',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'gradle-wrapper.properties', 'libs.versions.toml',
  'pubspec.yaml', 'pubspec.lock', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum',
  'pyproject.toml', 'requirements.txt', 'poetry.lock', 'Pipfile', 'Pipfile.lock',
  'composer.json', 'composer.lock', 'Package.swift', 'Package.resolved', 'pom.xml', 'Cartfile', 'Cartfile.resolved',
]);

const MAX_HASH_BYTES = 5 * 1024 * 1024;

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function gitOut(repo, args) {
  const r = git(repo, args);
  return r.status === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
}

export function isGitRepo(repo) {
  return gitOut(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function hashFile(repo, path) {
  const full = join(repo, path);
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    if (st.size > MAX_HASH_BYTES) return `big:${st.size}:${Math.floor(st.mtimeMs)}`;
    return createHash('sha256').update(readFileSync(full)).digest('hex');
  } catch {
    return null;
  }
}

export function statusEntries(repo) {
  const r = git(repo, ['status', '--porcelain', '-z', '-uall']);
  if (r.status !== 0) return [];
  const parts = r.stdout.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const s = parts[i];
    if (!s) continue;
    const x = s[0];
    const y = s[1];
    const path = s.slice(3);
    let orig = null;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') orig = parts[++i] ?? null;
    if (path.startsWith('.orchestrator/')) continue;
    entries.push({ x, y, path, orig });
  }
  return entries;
}

export function ensureExcluded(repo, pattern = '.orchestrator/') {
  const rel = gitOut(repo, ['rev-parse', '--git-path', 'info/exclude']);
  if (!rel) return false;
  const file = resolve(repo, rel);
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === pattern)) return false;
  appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`);
  return true;
}

export function inProgressOperation(repo) {
  const rel = gitOut(repo, ['rev-parse', '--git-dir']);
  if (!rel) return null;
  const dir = resolve(repo, rel);
  const has = (n) => existsSync(join(dir, n));
  if (has('MERGE_HEAD')) return 'merge';
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  if (has('BISECT_LOG')) return 'bisect';
  return null;
}

const lockPathOf = (repo) => join(repo, '.orchestrator', 'lock');

export function readLock(repo) {
  try {
    return JSON.parse(readFileSync(lockPathOf(repo), 'utf8'));
  } catch {
    return null;
  }
}

export function acquireLock({ repo, planId, runId = null, pid = null, now = new Date() }) {
  const path = lockPathOf(repo);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = now.toISOString();
  for (let attempt = 0; attempt < 3; attempt++) {
    const lock = { planId, runId, pid, repo, createdAt: stamp, updatedAt: stamp };
    try {
      writeFileSync(path, JSON.stringify(lock, null, 2), { flag: 'wx' });
      return lock;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const current = readLock(repo);
    if (!current) continue;
    if (current.planId !== planId) {
      throw new Error(`Repository is locked by plan ${current.planId} (run ${current.runId ?? 'none'}). Finish it or release it with: orch unlock`);
    }
    const updated = { ...current, runId: runId ?? current.runId, pid: pid ?? current.pid ?? null, updatedAt: stamp };
    writeFileSync(path, JSON.stringify(updated, null, 2));
    return updated;
  }
  throw new Error('Could not acquire the repository lock');
}

export function lockStatus(repo) {
  const lock = readLock(repo);
  if (!lock) return { held: false, live: false };
  return { held: true, live: lock.pid ? isAlive(lock.pid) : false, ...lock };
}

export function releaseLock({ repo, planId, force = false }) {
  const lock = readLock(repo);
  if (!lock) return false;
  if (lock.planId !== planId && !force) throw new Error(`Lock is owned by plan ${lock.planId}, not ${planId}`);
  unlinkSync(lockPathOf(repo));
  return true;
}

function manifestHashes(repo) {
  const listing = gitOut(repo, ['ls-files', '-co', '--exclude-standard']) ?? '';
  const out = {};
  for (const path of listing.split(/\r?\n/)) {
    if (path && MANIFEST_NAMES.has(basename(path)) && !path.startsWith('.orchestrator/')) out[path] = hashFile(repo, path);
  }
  return out;
}

export function takeSnapshot({ repo, planId, now = new Date() }) {
  const entries = statusEntries(repo);
  const tracked = entries.filter((e) => !(e.x === '?' && e.y === '?'));
  const stashRaw = tracked.length ? gitOut(repo, ['stash', 'create']) : null;
  const dirtyHashes = {};
  for (const e of entries) dirtyHashes[e.path] = hashFile(repo, e.path);
  const stashList = gitOut(repo, ['stash', 'list', '--format=%H']);
  return {
    planId,
    createdAt: now.toISOString(),
    head: gitOut(repo, ['rev-parse', 'HEAD']),
    branch: gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD']),
    stashHash: stashRaw ? stashRaw.trim() : null,
    stashList: stashList ? stashList.split(/\r?\n/).filter(Boolean) : [],
    porcelain: entries.map((e) => `${e.x}${e.y} ${e.path}`).sort().join('\n'),
    dirtyFiles: tracked.map((e) => e.path).sort(),
    untracked: entries.filter((e) => e.x === '?' && e.y === '?').map((e) => e.path).sort(),
    dirtyHashes,
    manifests: manifestHashes(repo),
    baseline: [],
  };
}

export async function preflight({ repo, planPath, config, acceptDirty = false, skipBaseline = false, now = new Date() }) {
  const planId = basename(planPath, '.md');
  if (!existsSync(planPath)) return { ok: false, error: `Plan not found: ${planPath}` };
  if (!isGitRepo(repo)) return { ok: false, error: `Not a git repository: ${repo}` };
  const op = inProgressOperation(repo);
  if (op) return { ok: false, error: `A ${op} is in progress; finish or abort it first` };

  const dirtyFiles = statusEntries(repo).map((e) => e.path).sort();
  if (dirtyFiles.length && !acceptDirty) {
    return { ok: false, needsConfirmation: true, dirtyFiles, error: 'The working tree has changes that are not part of this task' };
  }

  ensureExcluded(repo);
  let lock;
  try {
    lock = acquireLock({ repo, planId, now });
  } catch (e) {
    return { ok: false, error: e.message };
  }

  const snapshot = takeSnapshot({ repo, planId, now });
  if (!skipBaseline) {
    const commands = parsePlanValidation(readFileSync(planPath, 'utf8'));
    snapshot.baseline = await runValidation({
      repo,
      commands,
      forbidden: config.forbiddenCommands ?? [],
      timeoutMs: (config.safety?.validationTimeoutSeconds ?? 600) * 1000,
    });
  }
  const snapshotPath = join(repo, '.orchestrator', 'snapshots', `${planId}.json`);
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  return { ok: true, planId, lock, snapshot, snapshotPath, dirtyFiles };
}

const CSTYLE = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'php', 'scala', 'dart', 'gradle', 'groovy', 'm', 'mm', 'vue', 'svelte', 'scss', 'less']);
const BLOCK_ONLY = new Set(['css']);
const HASH = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'tf', 'r', 'pl', 'ps1', 'mk', 'properties', 'dockerfile']);
const HASH_INLINE = new Set(['py', 'rb', 'sh', 'bash', 'zsh', 'ps1']);
const HTML = new Set(['html', 'htm', 'xml', 'vue', 'svelte', 'xaml']);
const DASH = new Set(['sql', 'lua']);
const NO_SCAN = new Set(['md', 'mdx', 'json', 'lock', 'csv', 'snap', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'woff', 'woff2', 'ttf', 'pdf', 'zip']);
const MARKER = /\b(TODO|FIXME|XXX|HACK)\b/;

function extOf(file) {
  const base = basename(file).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  return extname(base).slice(1);
}

function isComment(ext, text) {
  const t = text.trim();
  if (!t) return false;
  if (CSTYLE.has(ext)) {
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*/') || /^\*(\s|$)/.test(t)) return true;
    if (/(^|\s)\/\/(?!\/)/.test(text) || /(^|\s)\/\*/.test(text)) return true;
  }
  if (BLOCK_ONLY.has(ext) && (t.startsWith('/*') || t.startsWith('*/') || /^\*(\s|$)/.test(t))) return true;
  if (HASH.has(ext)) {
    if (t.startsWith('#') && !t.startsWith('#!')) return true;
    if (HASH_INLINE.has(ext) && /\s#\s/.test(text)) return true;
  }
  if (ext === 'py' && (t.startsWith('"""') || t.startsWith("'''"))) return true;
  if (HTML.has(ext) && t.includes('<!--')) return true;
  if (DASH.has(ext) && t.startsWith('--')) return true;
  return false;
}

export function scanAddedComments(files) {
  const found = [];
  for (const { file, added } of files) {
    const ext = extOf(file);
    if (NO_SCAN.has(ext)) continue;
    for (const { line, text } of added) {
      if (isComment(ext, text)) found.push({ file, line, text: text.trim().slice(0, 120), kind: 'comment' });
      else if (MARKER.test(text)) found.push({ file, line, text: text.trim().slice(0, 120), kind: 'marker' });
    }
  }
  return found;
}

function changedSinceSnapshot(repo, snapshot) {
  const entries = statusEntries(repo);
  const changed = [];
  const present = new Set();
  for (const e of entries) {
    present.add(e.path);
    const deleted = e.x === 'D' || e.y === 'D';
    const hash = deleted ? null : hashFile(repo, e.path);
    const known = Object.prototype.hasOwnProperty.call(snapshot.dirtyHashes ?? {}, e.path);
    if (known && snapshot.dirtyHashes[e.path] === hash) continue;
    const status = deleted ? 'deleted' : e.x === '?' || e.x === 'A' ? 'added' : 'modified';
    changed.push({ path: e.path, status });
  }
  for (const path of Object.keys(snapshot.dirtyHashes ?? {})) {
    if (present.has(path)) continue;
    changed.push({ path, status: existsSync(join(repo, path)) ? 'modified' : 'deleted' });
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}

function addedLinesFromDiff(diff) {
  const added = [];
  let line = 0;
  for (const l of diff.split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) added.push({ line: line++, text: l.slice(1) });
  }
  return added;
}

function numstatTotal(repo, base, path, ignoreWhitespace) {
  const args = ['diff', '--numstat', ...(ignoreWhitespace ? ['-w'] : []), base, '--', path];
  const out = gitOut(repo, args);
  if (!out) return 0;
  const [a, d] = out.split('\t');
  return (Number(a) || 0) + (Number(d) || 0);
}

const ORCH_REF = /(^|[^\w.])\.orchestrator(?![\w-])/;
const IGNORE_FILE = /(^|\/)\.[a-z]*ignore$/;

export function postflightChecks({ repo, snapshot, planText, config }) {
  const violations = [];
  const recovery = [];
  const notes = [];
  const add = (code, severity, detail, path) => violations.push({ code, severity, detail, ...(path ? { path } : {}) });

  const head = gitOut(repo, ['rev-parse', 'HEAD']);
  if (snapshot.head && head !== snapshot.head) {
    add('HEAD_MOVED', 'grave', `HEAD moved from ${snapshot.head} to ${head}`);
    recovery.push(`git log --oneline ${snapshot.head}..HEAD`, `git reset --soft ${snapshot.head}`);
  }
  const branch = gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (snapshot.branch && branch !== snapshot.branch) {
    add('BRANCH_CHANGED', 'grave', `Branch changed from ${snapshot.branch} to ${branch}`);
    recovery.push(`git switch ${snapshot.branch}`);
  }
  const stash = gitOut(repo, ['stash', 'list', '--format=%H']);
  const stashNow = stash ? stash.split(/\r?\n/).filter(Boolean) : [];
  if (JSON.stringify(stashNow) !== JSON.stringify(snapshot.stashList ?? [])) {
    add('STASH_CHANGED', 'grave', 'The stash list changed');
    recovery.push('git stash list', 'git stash pop');
  }

  const scope = parseScope(planText);
  if (!scope.inScope.length) notes.push('The plan has no parsable "In scope" list: scope checks are limited');
  const base = snapshot.stashHash ?? snapshot.head;
  const changedFiles = changedSinceSnapshot(repo, snapshot);

  for (const f of changedFiles) {
    const inScope = matchScope(f.path, scope.inScope);
    if (f.status === 'deleted') {
      if (!inScope) {
        add('DELETED_OUT_OF_PLAN', 'grave', `Deleted a file that is not in the plan: ${f.path}`, f.path);
        recovery.push(`git checkout ${base} -- "${f.path}"`);
      }
    } else if (scope.inScope.length && !inScope) {
      add('OUT_OF_SCOPE', 'flag', `Changed a file outside the plan scope: ${f.path}`, f.path);
    }
  }

  const manifestsNow = manifestHashes(repo);
  const paths = new Set([...Object.keys(snapshot.manifests ?? {}), ...Object.keys(manifestsNow)]);
  for (const path of [...paths].sort()) {
    if ((snapshot.manifests ?? {})[path] === manifestsNow[path]) continue;
    if (!matchScope(path, scope.inScope)) add('MANIFEST_CHANGED', 'violation', `Manifest or lockfile changed without the plan asking: ${path}`, path);
  }

  const maxBytes = config.safety?.commentScanMaxFileBytes ?? 1000000;
  const sources = [];
  const maxWs = config.safety?.maxWhitespaceOnlyLines ?? 40;
  for (const f of changedFiles) {
    if (f.status === 'deleted') continue;
    const baseHasFile = base && git(repo, ['cat-file', '-e', `${base}:${f.path}`]).status === 0;
    if (baseHasFile) {
      const diff = gitOut(repo, ['diff', '-U0', '--no-color', base, '--', f.path]) ?? '';
      sources.push({ file: f.path, added: addedLinesFromDiff(diff) });
      const total = numstatTotal(repo, base, f.path, false);
      const meaningful = numstatTotal(repo, base, f.path, true);
      if (total - meaningful > maxWs) add('WHITESPACE_ONLY', 'flag', `${total - meaningful} whitespace-only line changes in ${f.path}`, f.path);
    } else {
      try {
        const full = join(repo, f.path);
        if (statSync(full).size > maxBytes) continue;
        const buf = readFileSync(full);
        if (buf.includes(0)) continue;
        sources.push({ file: f.path, added: buf.toString('utf8').split(/\r?\n/).map((text, i) => ({ line: i + 1, text })) });
      } catch {
        // unreadable file: nothing to scan
      }
    }
  }
  const comments = scanAddedComments(sources);
  if (comments.length) {
    const files = [...new Set(comments.map((c) => c.file))];
    add('NEW_COMMENT', 'flag', `${comments.length} added comment or marker line(s) in ${files.join(', ')}`);
  }

  const refFiles = sources.filter((f) => !IGNORE_FILE.test(f.file) && f.added.some((l) => ORCH_REF.test(l.text))).map((f) => f.file);
  if (refFiles.length) {
    add('ORCHESTRATOR_REFERENCE', 'violation', `Added code references .orchestrator/ (read-only for workers, absent in CI): ${refFiles.join(', ')}`, refFiles[0]);
  }

  const ok = !violations.some((v) => v.severity === 'grave' || v.severity === 'violation');
  return { ok, violations, changedFiles, comments, recovery, notes };
}

export function listRunDirs(repo) {
  const dir = join(repo, '.orchestrator', 'runs');
  return existsSync(dir) ? readdirSync(dir) : [];
}
