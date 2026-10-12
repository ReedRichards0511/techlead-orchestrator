import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { cleanEnv, isWindows } from '../platform.mjs';
import { killTree } from '../proc.mjs';
import { buildQuota, unavailableQuota, windowFromUsed } from './normalize.mjs';

const WEEKLY_MINUTES = 10080;

export function parseRateLimits(result, { now, config, estimatedMinutes = 0 }) {
  const rl = result.rateLimits ?? {};
  const windows = {};
  [rl.primary, rl.secondary].forEach((w, i) => {
    if (!w) return;
    const weekly = typeof w.windowDurationMins === 'number' ? w.windowDurationMins >= WEEKLY_MINUTES : i === 1;
    windows[weekly ? 'weekly' : 'short'] = windowFromUsed(w.usedPercent, w.resetsAt, now);
  });
  const quota = buildQuota({
    provider: 'codex',
    source: 'official',
    retrievedAt: now,
    windows,
    config,
    now,
    estimatedMinutes,
  });
  if (result.ordinaryUsageAllowed === false) return { ...quota, health: 'EXHAUSTED' };
  return quota;
}

export function fetchCodexQuota({ exe, args = ['app-server'], now = new Date(), config, timeoutMs = 10000, estimatedMinutes = 0 }) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let timer;
    const done = (q) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.pid) killTree(child.pid);
      resolve(q);
    };
    const fail = (reason) => done(unavailableQuota('codex', 'official', now, reason));

    try {
      child = spawn(exe, args, {
        env: cleanEnv(),
        shell: false,
        windowsHide: true,
        detached: !isWindows,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (e) {
      fail(e.message);
      return;
    }
    child.on('error', (e) => fail(e.message));
    child.on('exit', () => fail('app-server exited before answering'));
    child.stdin.on('error', () => {});

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error) return fail(msg.error.message ?? 'initialize failed');
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (msg.id === 2) {
        if (msg.error || !msg.result) return fail(msg.error?.message ?? 'empty result');
        done(parseRateLimits(msg.result, { now, config, estimatedMinutes }));
      }
    });

    timer = setTimeout(() => fail('timeout'), timeoutMs);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'orch', title: 'orch', version: '0.0.1' } } });
  });
}
