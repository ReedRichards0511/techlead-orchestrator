import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readJson, writeJson } from './config.mjs';
import { parseOutput } from './adapters/index.mjs';

export const USAGE_FIELDS = ['promptTokens', 'cachedTokens', 'cacheWriteTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'];
export const USAGE_SOURCES = { devin: 'devin-export', codex: 'codex-jsonl', agy: 'agy-result', claude: 'claude-transcript' };
const valid = value => Number.isSafeInteger(value) && value >= 0;
const total = values => values.every(valid) && valid(values.reduce((a, b) => a + b, 0)) ? values.reduce((a, b) => a + b, 0) : undefined;

export function normalizeUsage(harness, raw) {
  if (!raw || typeof raw !== 'object' || !USAGE_SOURCES[harness]) return null;
  let values;
  if (harness === 'devin') values = raw.source === USAGE_SOURCES.devin ? raw : {};
  else if (harness === 'claude') values = {
    promptTokens: total([raw.input_tokens, raw.cache_creation_input_tokens, raw.cache_read_input_tokens]),
    cachedTokens: raw.cache_read_input_tokens,
    cacheWriteTokens: raw.cache_creation_input_tokens,
    completionTokens: raw.output_tokens,
  };
  else values = {
    promptTokens: raw.input_tokens ?? raw.prompt_tokens,
    cachedTokens: raw.cached_input_tokens,
    cacheWriteTokens: raw.cache_write_input_tokens,
    completionTokens: raw.output_tokens ?? raw.completion_tokens,
    reasoningTokens: raw.reasoning_output_tokens,
    totalTokens: harness === 'agy' ? raw.total_tokens : undefined,
  };
  const usage = Object.fromEntries(USAGE_FIELDS.filter(k => valid(values[k])).map(k => [k, values[k]]));
  if (usage.totalTokens === undefined) {
    const sum = total([usage.promptTokens, usage.completionTokens]);
    if (sum !== undefined) usage.totalTokens = sum;
  }
  return Object.keys(usage).length ? { source: USAGE_SOURCES[harness], ...usage, ...(raw.partial === true ? { partial: true } : {}) } : null;
}

function events(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/).flatMap(line => {
      try { const event = JSON.parse(line); return event && typeof event === 'object' ? [event] : []; }
      catch { return line.trim() ? [{ unreadable: true }] : []; }
    });
  } catch { return []; }
}

export function findTranscript(session, configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  if (!/^[a-zA-Z0-9_-]+$/.test(session ?? '')) return null;
  const projects = join(configDir, 'projects');
  try {
    for (const dir of readdirSync(projects, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const file = join(projects, dir.name, `${session}.jsonl`);
      if (existsSync(file)) return file;
    }
  } catch {}
  return null;
}

function taskPath(repo, task) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(task ?? '')) throw new Error('Use a task id with letters, numbers, hyphens or underscores (up to 128 characters)');
  return join(repo, '.orchestrator', 'usage', `${task}.json`);
}

export function startUsage({ repo, task, session, transcript, now = new Date() }) {
  const path = taskPath(repo, task);
  if (existsSync(path)) {
    if (readJson(path)?.report) throw new Error(`Task ${task} is already closed; use a new id for a new implementation`);
    return { task, started: true, resumed: true };
  }
  const transcriptPath = transcript ? resolve(transcript) : findTranscript(session);
  const log = transcriptPath ? events(transcriptPath) : [];
  const prompt = log.findLast(e => e.type === 'user' && !e.isSidechain && !e.isMeta && e.uuid
    && (typeof e.message?.content === 'string' || (Array.isArray(e.message?.content) && e.message.content.some(c => c?.type === 'text'))));
  const anchor = prompt?.uuid ?? null;
  writeJson(path, {
    task, startedAt: now.toISOString(), session: session ?? null, transcriptPath, anchor, roleActive: true,
    planPath: resolve(repo, '.orchestrator', 'plans', `${task}.md`),
  });
  return { task, started: true, architectAvailable: Boolean(anchor) };
}

function addActor(actors, key, label, usage, complete) {
  const actor = actors.get(key) ?? { label, runs: 0, measuredRuns: 0, complete: true, usage: {} };
  actor.runs++;
  actor.complete &&= complete && valid(usage?.totalTokens) && !usage?.partial;
  if (usage) {
    actor.measuredRuns++;
    for (const field of USAGE_FIELDS) if (valid(usage[field])) {
      if (field in actor.usage && !valid(actor.usage[field])) continue;
      actor.usage[field] = total([actor.usage[field] ?? 0, usage[field]]);
      if (!valid(actor.usage[field])) actor.complete = false;
    }
  }
  actors.set(key, actor);
}

const modelName = model => ({
  'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5',
  'devin/gpt-6-1-sol': 'GPT-6.1 Sol', 'codex/gpt-6.1-sol': 'GPT-6.1 Sol',
  'devin/swe-2': 'SWE-2', 'devin/claude-sonnet-5-5': 'Sonnet 5.5',
  'devin/claude-haiku-5-5': 'Haiku 5.5', 'devin/deepseek-v4-1-flash': 'DeepSeek V4.1 Flash',
  'codex/gpt-6-luna': 'GPT-6 Luna', 'agy/gemini-3.8-flash': 'Gemini 3.8 Flash',
}[model] ?? model ?? 'modelo desconocido');

export function reportUsage({ repo, task, session, now = new Date() }) {
  const path = taskPath(repo, task);
  const start = readJson(path);
  if (!start?.startedAt) throw new Error(`No usage baseline for ${task}; run orch usage start before analyzing the task`);
  if (start.report) return start.report;
  const actors = new Map();
  const log = start.transcriptPath ? events(start.transcriptPath) : [];
  const anchor = start.anchor ? log.findIndex(e => e.uuid === start.anchor) : -1;
  let architectComplete = anchor >= 0 && (!session || session === start.session);
  const collect = (entries, messages, accept) => {
    for (const e of entries) {
      if (e.unreadable) { architectComplete = false; continue; }
      if (e.type !== 'assistant' || e.message?.model === '<synthetic>' || !accept(e)) continue;
      if (!e.message?.id || !e.message?.model) { architectComplete = false; continue; }
      const key = e.message.id;
      const usage = normalizeUsage('claude', e.message.usage);
      const previous = messages.get(key);
      // Streaming blocks repeat the same request; keep each counter's maximum, not their sum.
      if (previous?.usage && usage) for (const field of USAGE_FIELDS) {
        if (valid(previous.usage[field])) usage[field] = Math.max(previous.usage[field], usage[field] ?? 0);
      }
      messages.set(key, { model: e.message.model, usage: usage ?? previous?.usage ?? null });
    }
  };
  const messages = new Map();
  if (anchor >= 0) collect(log.slice(anchor + 1), messages, e => !e.isSidechain);
  // Claude Code stores each subagent (Figma reader, auditor) in <session>/subagents/*.jsonl next to the main transcript.
  const subagents = new Map();
  if (anchor >= 0 && start.session) {
    const dir = join(dirname(start.transcriptPath), start.session, 'subagents');
    const since = Date.parse(start.startedAt);
    let files = [];
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch {}
    for (const file of files) collect(events(join(dir, file)), subagents, e => Date.parse(e.timestamp) >= since);
  }
  for (const message of messages.values()) addActor(actors, `claude/${message.model}`, modelName(message.model), message.usage, architectComplete);
  for (const message of subagents.values()) addActor(actors, `claude-sub/${message.model}`, `${modelName(message.model)} (subagentes)`, message.usage, architectComplete);
  if (!messages.size) addActor(actors, 'claude/unknown', 'Opus', null, false);

  const runsDir = join(repo, '.orchestrator', 'runs');
  let runIds = [];
  try { runIds = readdirSync(runsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  for (const runId of runIds) {
    const dir = join(runsDir, runId);
    let status;
    try { status = readJson(join(dir, 'status.json')); } catch {}
    const meta = status?.meta;
    if (!meta?.planPath) {
      if (runId.startsWith(`${task}-`)) addActor(actors, 'worker/unknown', 'Worker (registro no disponible)', null, false);
      continue;
    }
    if (resolve(meta.planPath) !== start.planPath) continue;
    const startedAt = Date.parse(status.startedAt);
    if (!Number.isFinite(startedAt)) { addActor(actors, 'worker/unknown', 'Worker (inicio no disponible)', null, false); continue; }
    if (startedAt < Date.parse(start.startedAt)) continue;
    const read = name => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
    const parsed = parseOutput(meta.harness, { stdout: read('stdout.log'), stderr: read('stderr.log'), runDir: dir });
    const usage = normalizeUsage(meta.harness, parsed.usage);
    const harness = { devin: 'Devin', codex: 'Codex', agy: 'Antigravity' }[meta.harness] ?? meta.harness;
    addActor(actors, `${meta.model}@${meta.effort}`, `${harness} / ${modelName(meta.model)} / ${meta.effort}`, usage, ['exited', 'timeout', 'error'].includes(status.state));
  }
  const rows = [...actors.values()];
  const totalTokens = rows.some(a => valid(a.usage.totalTokens)) ? total(rows.map(a => a.usage.totalTokens ?? 0)) : null;
  const report = {
    task, measuredAt: now.toISOString(), actors: rows,
    totalTokens: totalTokens ?? null,
    complete: architectComplete && rows.every(a => a.complete) && valid(totalTokens),
    cutoff: 'before-final-response',
  };
  writeJson(path, { ...start, report });
  return report;
}

export function formatUsage(report) {
  const count = n => valid(n) ? n.toLocaleString('es-EC') : 'no disponible';
  const lines = report.actors.map(a => `${a.label}: ${count(a.usage.totalTokens)}${valid(a.usage.totalTokens) ? ' tokens' : ''}${!a.complete && valid(a.usage.totalTokens) ? ' (parcial)' : ''}${valid(a.usage.cachedTokens) ? ` · caché ${count(a.usage.cachedTokens)}` : ''}`);
  lines.push(`Total medido: ${count(report.totalTokens)}${valid(report.totalTokens) ? ' tokens' : ''}${report.complete ? '' : ' (parcial)'}`);
  lines.push('Hasta el cierre; no incluye la respuesta final de Claude.');
  return lines.join('\n');
}
