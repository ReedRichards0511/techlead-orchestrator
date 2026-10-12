import { spawn, spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, isWindows } from './platform.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.orchestrator']);

export function readStatus(statusPath) {
  try {
    return JSON.parse(readFileSync(statusPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(statusPath, data) {
  const tmp = `${statusPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, statusPath);
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

export function killTree(pid) {
  if (!pid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function treeSignature(dir, depth = 0) {
  let newest = 0;
  let count = 0;
  if (depth > 6) return { newest, count };
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { newest, count };
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = join(dir, e.name);
    try {
      const m = statSync(full).mtimeMs;
      if (m > newest) newest = m;
    } catch {}
    count++;
    if (e.isDirectory()) {
      const sub = treeSignature(full, depth + 1);
      if (sub.newest > newest) newest = sub.newest;
      count += sub.count;
    }
  }
  return { newest, count };
}

export function supervise(spec) {
  const {
    exe,
    args = [],
    cwd,
    env,
    stdinPath,
    stdoutPath,
    stderrPath,
    statusPath,
    wallMs,
    idleMs,
    watchDir,
    heartbeatMs = 30000,
  } = spec;

  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const state = { state: 'running', pid: null, startedAt, heartbeatAt: startedAt, meta: spec.meta ?? null };
    const fds = [];
    const open = (p, flag) => {
      const fd = openSync(p, flag);
      fds.push(fd);
      return fd;
    };
    const closeAll = () => {
      for (const fd of fds) {
        try {
          closeSync(fd);
        } catch {}
      }
    };

    let child;
    let settled = false;
    let timeoutReason = null;
    const timers = [];

    const finish = (final) => {
      if (settled) return;
      settled = true;
      for (const t of timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      closeAll();
      const out = { ...state, ...final, endedAt: new Date().toISOString() };
      if (statusPath) writeStatus(statusPath, out);
      resolve(out);
    };

    try {
      const stdin = stdinPath ? open(stdinPath, 'r') : 'ignore';
      const out = open(stdoutPath, 'w');
      const err = open(stderrPath, 'w');
      child = spawn(exe, args, {
        cwd,
        env: env ?? cleanEnv(),
        shell: false,
        windowsHide: true,
        detached: !isWindows,
        stdio: [stdin, out, err],
      });
    } catch (e) {
      finish({ state: 'error', reason: e.message });
      return;
    }

    child.on('error', (e) => finish({ state: 'error', reason: e.message }));

    child.on('spawn', () => {
      state.pid = child.pid;
      if (statusPath) writeStatus(statusPath, state);

      timers.push(
        setInterval(() => {
          state.heartbeatAt = new Date().toISOString();
          if (statusPath && !settled) writeStatus(statusPath, state);
        }, heartbeatMs),
      );

      const kill = (reason) => {
        if (timeoutReason || settled) return;
        timeoutReason = reason;
        killTree(child.pid);
        timers.push(setTimeout(() => finish({ state: 'timeout', reason }), 3000));
      };

      if (wallMs) timers.push(setTimeout(() => kill('wall'), wallMs));

      if (idleMs) {
        let last = '';
        let lastChange = Date.now();
        const signature = () => {
          const tree = watchDir ? treeSignature(watchDir) : { newest: 0, count: 0 };
          return `${fileSize(stdoutPath)}|${fileSize(stderrPath)}|${tree.newest}|${tree.count}`;
        };
        last = signature();
        timers.push(
          setInterval(
            () => {
              const sig = signature();
              if (sig !== last) {
                last = sig;
                lastChange = Date.now();
              } else if (Date.now() - lastChange >= idleMs) {
                kill('idle');
              }
            },
            Math.max(100, Math.min(500, Math.floor(idleMs / 4))),
          ),
        );
      }
    });

    child.on('exit', (code, signal) => {
      if (timeoutReason) finish({ state: 'timeout', reason: timeoutReason, exitCode: code, signal });
      else finish({ state: 'exited', exitCode: code, signal });
    });
  });
}

export function capture(exe, args = [], { cwd, env, input, timeoutMs = 60000, verbatim = false } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    try {
      child = spawn(exe, args, {
        cwd,
        env: env ?? cleanEnv(),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: !isWindows,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      done({ status: -1, error: e.message });
      return;
    }
    child.on('error', (e) => done({ status: -1, error: e.message }));
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('close', (code, signal) => done({ status: code ?? -1, signal, timedOut }));
  });
}

export function launchBackground(spec) {
  const specPath = join(dirname(spec.statusPath), 'supervisor-spec.json');
  writeFileSync(specPath, JSON.stringify(spec));
  writeStatus(spec.statusPath, { state: 'starting', pid: null, startedAt: new Date().toISOString(), meta: spec.meta ?? null });
  const supervisor = join(dirname(fileURLToPath(import.meta.url)), 'supervisor.mjs');
  const child = spawn(process.execPath, [supervisor, specPath], {
    cwd: spec.cwd,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { supervisorPid: child.pid };
}
