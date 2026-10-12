import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise, launchBackground, readStatus, isAlive } from '../lib/proc.mjs';

const node = process.execPath;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-proc-'));
  return {
    dir,
    stdoutPath: join(dir, 'stdout.log'),
    stderrPath: join(dir, 'stderr.log'),
    statusPath: join(dir, 'status.json'),
  };
}

async function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

test('supervise captures stdout/stderr to files and records exit code', async () => {
  const s = setup();
  const result = await supervise({
    exe: node,
    args: ['-e', "console.log('hello'); console.error('warn'); process.exit(0)"],
    cwd: s.dir,
    ...s,
  });
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 0);
  assert.match(readFileSync(s.stdoutPath, 'utf8'), /hello/);
  assert.match(readFileSync(s.stderrPath, 'utf8'), /warn/);
  const st = readStatus(s.statusPath);
  assert.equal(st.state, 'exited');
  assert.equal(st.exitCode, 0);
  assert.ok(st.endedAt);
});

test('supervise records a non-zero exit code', async () => {
  const s = setup();
  const result = await supervise({ exe: node, args: ['-e', 'process.exit(7)'], cwd: s.dir, ...s });
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 7);
});

test('supervise pipes a stdin file to the child', async () => {
  const s = setup();
  const stdinPath = join(s.dir, 'packet.md');
  writeFileSync(stdinPath, 'packet-body');
  await supervise({
    exe: node,
    args: ['-e', "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('got:'+d))"],
    cwd: s.dir,
    stdinPath,
    ...s,
  });
  assert.match(readFileSync(s.stdoutPath, 'utf8'), /got:packet-body/);
});

test('supervise does not use a shell (metacharacters stay literal)', async () => {
  const s = setup();
  await supervise({ exe: node, args: ['-e', 'console.log(process.argv[1])', 'a && b | c'], cwd: s.dir, ...s });
  assert.match(readFileSync(s.stdoutPath, 'utf8'), /a && b \| c/);
});

test('supervise reports spawn errors as state=error', async () => {
  const s = setup();
  const result = await supervise({ exe: join(s.dir, 'does-not-exist.exe'), args: [], cwd: s.dir, ...s });
  assert.equal(result.state, 'error');
  assert.ok(result.reason);
});

test('wall-clock timeout kills the whole process tree', async () => {
  const s = setup();
  const pidFile = join(s.dir, 'grandchild.pid');
  const parentCode = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
    setInterval(()=>{},1000);
  `;
  const result = await supervise({
    exe: node,
    args: ['-e', parentCode],
    cwd: s.dir,
    wallMs: 1500,
    ...s,
  });
  assert.equal(result.state, 'timeout');
  assert.equal(result.reason, 'wall');
  const gpid = Number(readFileSync(pidFile, 'utf8'));
  await waitFor(() => !isAlive(gpid), 5000);
  assert.equal(isAlive(gpid), false);
});

test('idle timeout fires when there is no output or activity', async () => {
  const s = setup();
  const result = await supervise({
    exe: node,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: s.dir,
    idleMs: 1200,
    wallMs: 20000,
    ...s,
  });
  assert.equal(result.state, 'timeout');
  assert.equal(result.reason, 'idle');
});

test('idle timeout does not fire while output keeps flowing', async () => {
  const s = setup();
  const result = await supervise({
    exe: node,
    args: ['-e', "let n=0;const t=setInterval(()=>{console.log('tick');if(++n>=6){clearInterval(t)}},400)"],
    cwd: s.dir,
    idleMs: 1200,
    wallMs: 20000,
    ...s,
  });
  assert.equal(result.state, 'exited');
  assert.equal(result.exitCode, 0);
});

test('idle timeout counts working-tree activity as liveness', async () => {
  const s = setup();
  const watchDir = join(s.dir, 'repo');
  const code = `
    const fs = require('node:fs');
    fs.mkdirSync(${JSON.stringify(watchDir)}, { recursive: true });
    let n = 0;
    const t = setInterval(() => { fs.writeFileSync(${JSON.stringify(join(watchDir, 'f.txt'))}, String(n)); if (++n >= 6) clearInterval(t); }, 400);
  `;
  const result = await supervise({
    exe: node,
    args: ['-e', code],
    cwd: s.dir,
    idleMs: 1200,
    wallMs: 20000,
    watchDir,
    ...s,
  });
  assert.equal(result.state, 'exited');
});

test('heartbeat updates status.json while running', async () => {
  const s = setup();
  const p = supervise({
    exe: node,
    args: ['-e', 'setTimeout(()=>{},1500)'],
    cwd: s.dir,
    heartbeatMs: 300,
    ...s,
  });
  const first = await waitFor(() => (existsSync(s.statusPath) ? readStatus(s.statusPath) : null));
  assert.equal(first.state, 'running');
  assert.ok(first.pid);
  await waitFor(() => readStatus(s.statusPath).heartbeatAt !== first.heartbeatAt);
  await p;
});

test('launchBackground returns immediately and the supervisor finishes the run', async () => {
  const s = setup();
  const t0 = Date.now();
  const { supervisorPid } = launchBackground({
    exe: node,
    args: ['-e', "setTimeout(()=>console.log('bg-done'),1200)"],
    cwd: s.dir,
    ...s,
  });
  assert.ok(Date.now() - t0 < 1000, 'launchBackground must not block');
  assert.ok(supervisorPid);
  const st = await waitFor(() => {
    if (!existsSync(s.statusPath)) return null;
    const x = readStatus(s.statusPath);
    return x.state === 'exited' ? x : null;
  }, 15000);
  assert.equal(st.exitCode, 0);
  assert.match(readFileSync(s.stdoutPath, 'utf8'), /bg-done/);
});

test('capture returns status, stdout and stderr without a shell', async () => {
  const { capture } = await import('../lib/proc.mjs');
  const r = await capture(node, ['-e', "console.log(process.argv[1]);console.error('e');process.exit(3)", 'x && y']);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /x && y/);
  assert.match(r.stderr, /e/);
});

test('capture feeds input on stdin', async () => {
  const { capture } = await import('../lib/proc.mjs');
  const r = await capture(node, ['-e', "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(d.toUpperCase()))"], { input: 'abc' });
  assert.match(r.stdout, /ABC/);
});

test('capture times out and kills the child', async () => {
  const { capture } = await import('../lib/proc.mjs');
  const r = await capture(node, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 500 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
});

test('capture reports a missing executable instead of throwing', async () => {
  const { capture } = await import('../lib/proc.mjs');
  const r = await capture(join(tmpdir(), 'no-such-binary.exe'), []);
  assert.notEqual(r.status, 0);
  assert.ok(r.error);
});
