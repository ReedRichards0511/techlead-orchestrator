import { join } from 'node:path';
import { readJson, writeJson } from '../config.mjs';
import { agyQuota } from './agy.mjs';
import {
  cacheGet,
  freshnessFor,
  levelFor,
  manualQuota,
  reactiveExhausted,
  unavailableQuota,
  unknownQuota,
} from './normalize.mjs';

export const PROVIDERS = ['claude', 'devin', 'codex', 'antigravity'];
const NO_CACHE = new Set(['claude', 'antigravity']);
const STICKY_SOURCES = new Set(['manual', 'reactive']);
const REACTIVE_TTL_SECONDS = 3600;

const cachePath = (stateDir) => join(stateDir, 'quota-cache.json');

function refreshFreshness(entry, now, ttl) {
  return { ...entry, freshness: entry.freshness === 'UNAVAILABLE' ? 'UNAVAILABLE' : freshnessFor({ source: entry.source, retrievedAt: entry.retrievedAt, now, ttl }) };
}

async function fetchProvider(provider, { deps, config, now, estimatedMinutes }) {
  try {
    if (provider === 'codex') return await deps.fetchCodex({ config, now, estimatedMinutes });
    if (provider === 'claude') return deps.readClaude({ config, now, estimatedMinutes });
    if (provider === 'devin') return deps.fetchDevin ? await deps.fetchDevin({ config, now, estimatedMinutes }) : null;
    return agyQuota();
  } catch (e) {
    return unavailableQuota(provider, 'official', now, e.message);
  }
}

export async function getAllQuotas({ stateDir, config, now = new Date(), deps, refresh = false, estimatedMinutes = 0 }) {
  const ttl = config.quotaTtlSeconds ?? 600;
  const cache = readJson(cachePath(stateDir), {}) ?? {};
  const result = {};

  for (const provider of PROVIDERS) {
    const prior = cache[provider];
    const reactiveExpired =
      prior?.source === 'reactive' && (now.getTime() - new Date(prior.retrievedAt).getTime()) / 1000 > REACTIVE_TTL_SECONDS;
    const sticky = prior && STICKY_SOURCES.has(prior.source) && !reactiveExpired;

    if (prior?.source === 'reactive' && !reactiveExpired) {
      result[provider] = refreshFreshness(prior, now, ttl);
      continue;
    }

    if (!NO_CACHE.has(provider) && !refresh) {
      const hit = cacheGet(cache, provider, now, ttl);
      if (hit) {
        result[provider] = refreshFreshness(hit, now, ttl);
        continue;
      }
    }

    const fetched = await fetchProvider(provider, { deps, config, now, estimatedMinutes });
    const usable = fetched?.available === true;

    if (usable) result[provider] = fetched;
    else if (sticky) result[provider] = refreshFreshness(prior, now, ttl);
    else result[provider] = fetched ?? unknownQuota(provider);
  }

  writeJson(cachePath(stateDir), result);
  return result;
}

export function setManual({ stateDir, provider, daily, weekly, now = new Date(), config }) {
  const cache = readJson(cachePath(stateDir), {}) ?? {};
  cache[provider] = manualQuota({ provider, daily, weekly, now, config });
  writeJson(cachePath(stateDir), cache);
  return cache[provider];
}

export function markExhausted({ stateDir, provider, now = new Date() }) {
  const cache = readJson(cachePath(stateDir), {}) ?? {};
  cache[provider] = reactiveExhausted(provider, now);
  writeJson(cachePath(stateDir), cache);
  return cache[provider];
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.max(0, Math.floor(seconds / 60))}m`;
}

const LABELS = { short: '5h', daily: 'daily', weekly: 'weekly' };

export function formatDashboard(all, config) {
  const lines = [];
  for (const provider of PROVIDERS) {
    const q = all[provider];
    if (!q) continue;
    const extra = ['PROTECTED', 'EXHAUSTED'].includes(q.health) ? `   health: ${q.health}` : '';
    lines.push(`${provider.toUpperCase().padEnd(13)} source: ${q.source.padEnd(11)} freshness: ${q.freshness}${extra}`);
    const rows = Object.entries(q.windows).filter(([, w]) => typeof w === 'object');
    if (!rows.length) {
      const hint = provider === 'devin' ? 'manual/reactive only' : 'reactive only';
      lines.push(`  ${'—'.padEnd(9)} UNKNOWN (${hint})${q.reason ? ` [${q.reason}]` : ''}`);
      continue;
    }
    for (const [name, w] of rows) {
      const level = levelFor(w.remainingPercent, config.thresholds);
      const reserve = name === 'weekly' && (config.reserves?.[provider] ?? 0) > 0 ? ` (reserve ${config.reserves[provider]}%)` : '';
      lines.push(
        `  ${LABELS[name].padEnd(9)} ${String(Math.round(w.remainingPercent)).padStart(3)}% remaining   reset ${formatDuration(w.resetInSeconds).padEnd(7)} ${level}${reserve}`,
      );
    }
  }
  return lines.join('\n');
}
