import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildInvocation as defaultBuild, parseOutput } from './adapters/index.mjs';
import { classifyRun, validateResult } from './classify.mjs';
import { applyDevinAllowlist, restoreDevinAllowlist } from './devin-allow.mjs';
import { parsePlanValidation } from './validate.mjs';
import { gitPorcelain } from './git.mjs';
import { renderContinuationPacket, renderPacket, renderRepairPacket } from './packet.mjs';
import { resolveExecutable } from './platform.mjs';
import { launchBackground, readStatus } from './proc.mjs';
import { acquireLock, readLock } from './safety.mjs';

const HEARTBEAT_MS = 30000;
const ENDED = new Set(['exited', 'timeout', 'error']);
const PACKET_RENDERERS = { repair: renderRepairPacket, continuation: renderContinuationPacket };

const runDirOf = (repo, runId) => join(repo, '.orchestrator', 'runs', runId);

function appendEvent(runDir, event) {
  appendFileSync(join(runDir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

function stamp(now) {
  return now.toISOString().replace(/[-:]/g, '').slice(0, 15);
}

export function startRun({
  repo,
  planPath,
  klass,
  entry,
  effort,
  config,
  permission,
  packetText,
  packetKind,
  packetData,
  projectRules,
  baseline,
  project,
  stack,
  title,
  buildInvocation = defaultBuild,
  resolveExe,
  timeouts = {},
  snapshot,
  now = new Date(),
}) {
  if (!existsSync(planPath)) throw new Error(`Plan not found: ${planPath}`);
  const resolve = resolveExe ?? ((name) => resolveExecutable(name, { overrides: config.platformOverrides?.paths ?? {} }));

  if (packetKind && !PACKET_RENDERERS[packetKind]) throw new Error(`Unknown packet kind: ${packetKind} (expected repair or continuation)`);

  const planId = basename(planPath, '.md');
  assertWriterFree(repo, planId);
  let runId = `${planId}-${stamp(now)}`;
  for (let n = 2; existsSync(runDirOf(repo, runId)); n++) runId = `${planId}-${stamp(now)}-${n}`;
  const runDir = runDirOf(repo, runId);
  mkdirSync(runDir, { recursive: true });

  const resultPath = join(runDir, 'result.json');
  const packetPath = join(runDir, 'packet.md');
  writeFileSync(
    packetPath,
    packetText ??
      (packetKind ? PACKET_RENDERERS[packetKind] : renderPacket)({
        ...packetData,
        runId,
        project: project ?? basename(repo),
        stack,
        title: title ?? planId,
        klass,
        planPath,
        workspace: repo,
        resultPath,
        projectRules: packetData?.projectRules ?? projectRules,
        baseline,
        config,
      }),
  );
  const launchSnapshot = snapshot ?? (() => {
    const porcelain = gitPorcelain(repo);
    return porcelain === null ? null : { porcelain };
  })();
  if (launchSnapshot) writeFileSync(join(runDir, 'snapshot.json'), JSON.stringify(launchSnapshot, null, 2));

  const inv = buildInvocation({ entry, effort, packetPath, repo, config, permission, runDir, resultPath });
  const exe = resolve(inv.exeName);
  if (!exe) throw new Error(`Executable not found: ${inv.exeName}`);

  const wallMs = timeouts.wallMs ?? (config.timeouts?.[klass] ?? 60) * 60000;
  const idleMs = timeouts.idleMs ?? (config.timeouts?.idleMinutes ?? 15) * 60000;
  const meta = {
    runId,
    harness: entry.harness,
    model: entry.id,
    effort,
    klass,
    planId,
    planPath,
    permission: inv.permission ?? permission ?? null,
    heartbeatMs: HEARTBEAT_MS,
  };

  acquireLock({ repo, planId, runId, now });
  appendEvent(runDir, { type: 'launch', ...meta });

  let devinAllowlist = { applied: false, reason: 'not a restricted Devin run' };
  if (entry.harness === 'devin' && meta.permission !== 'dangerous' && config.permissions?.devin?.allowlist !== false) {
    devinAllowlist = applyDevinAllowlist({ repo, runDir, commands: parsePlanValidation(readText(planPath)) });
    appendEvent(runDir, { type: 'allowlist', applied: devinAllowlist.applied, rules: devinAllowlist.rules?.length ?? 0, reason: devinAllowlist.reason });
  }

  let supervisorPid;
  try {
    ({ supervisorPid } = launchBackground({
      exe,
      args: inv.args,
      cwd: inv.cwd ?? repo,
      stdinPath: inv.stdinPath ?? undefined,
      stdoutPath: join(runDir, 'stdout.log'),
      stderrPath: join(runDir, 'stderr.log'),
      statusPath: join(runDir, 'status.json'),
      wallMs,
      idleMs,
      watchDir: repo,
      heartbeatMs: HEARTBEAT_MS,
      meta,
    }));
  } catch (e) {
    restoreDevinAllowlist({ repo, runDir });
    throw e;
  }
  acquireLock({ repo, planId, runId, pid: supervisorPid, now });
  return { runId, runDir, statusPath: join(runDir, 'status.json'), supervisorPid, devinAllowlist };
}

function assertWriterFree(repo, planId) {
  const lock = readLock(repo);
  if (!lock) return;
  if (lock.planId !== planId) {
    throw new Error(`Repository is locked by plan ${lock.planId} (run ${lock.runId ?? 'none'}). Finish it or release it with: orch unlock`);
  }
  if (!lock.runId) return;
  const st = readStatus(join(runDirOf(repo, lock.runId), 'status.json'));
  if (st && !ENDED.has(st.state)) throw new Error(`Run ${lock.runId} of this plan is still running`);
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function readResult(path) {
  if (!existsSync(path)) return { result: null, invalid: false, errors: [] };
  let obj;
  try {
    obj = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { result: null, invalid: true, errors: [`result.json is not valid JSON: ${e.message}`] };
  }
  const v = validateResult(obj);
  return v.ok ? { result: obj, invalid: false, errors: [] } : { result: null, invalid: true, errors: v.errors };
}

function logFinishOnce(runDir, st, classification) {
  const eventsPath = join(runDir, 'events.jsonl');
  if (readText(eventsPath).includes('"type":"finish"')) return;
  appendEvent(runDir, { type: 'finish', state: st.state, exitCode: st.exitCode ?? null, classification: classification.status, action: classification.action });
}

export function getStatus({ repo, runId, rateRetries = 0, now = new Date() }) {
  const runDir = runDirOf(repo, runId);
  const st = readStatus(join(runDir, 'status.json'));
  if (!st) return null;
  const out = { ...st, runId, runDir };
  out.elapsedSeconds = Math.max(0, Math.round((now - new Date(st.startedAt)) / 1000));

  if (!ENDED.has(st.state)) {
    const beat = new Date(st.heartbeatAt ?? st.startedAt);
    const every = st.meta?.heartbeatMs ?? HEARTBEAT_MS;
    out.lost = st.state === 'running' && now - beat > every * 3;
    return out;
  }

  restoreDevinAllowlist({ repo, runDir });
  const harness = st.meta?.harness;
  const stdout = readText(join(runDir, 'stdout.log'));
  const stderr = readText(join(runDir, 'stderr.log'));
  const { result, invalid, errors } = readResult(join(runDir, 'result.json'));
  const snapshot = existsSync(join(runDir, 'snapshot.json')) ? JSON.parse(readText(join(runDir, 'snapshot.json'))) : null;
  let diffEmpty = null;
  if (snapshot && typeof snapshot.porcelain === 'string') {
    const current = gitPorcelain(repo);
    diffEmpty = current === null ? null : current === snapshot.porcelain;
  }
  const classification = classifyRun({
    harness,
    state: st.state,
    exitCode: st.exitCode ?? null,
    stderr,
    parsed: parseOutput(harness, { exitCode: st.exitCode, stdout, stderr }),
    result,
    resultInvalid: invalid,
    diffEmpty,
    permission: st.meta?.permission,
    rateRetries,
  });
  if (invalid) classification.detail = `${classification.detail}; result.json invalid: ${errors.join('; ')}`;
  out.classification = classification;
  logFinishOnce(runDir, st, classification);
  return out;
}

export async function waitRun({ repo, runId, timeoutMs = 100000, pollMs = 400, rateRetries = 0 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = getStatus({ repo, runId, rateRetries });
    if (!st) throw new Error(`Unknown run: ${runId}`);
    if (ENDED.has(st.state) || st.lost) return st;
    if (Date.now() >= deadline) return { ...st, waiting: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
