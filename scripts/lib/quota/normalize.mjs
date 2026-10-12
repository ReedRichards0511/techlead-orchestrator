const LEVELS = ['EXHAUSTED', 'CRITICAL', 'LOW', 'MODERATE', 'HEALTHY'];
const WEEKLY_FAR_SECONDS = 3 * 86400;
const WINDOW_NAMES = ['short', 'daily', 'weekly'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();

export function levelFor(remainingPercent, thresholds) {
  if (remainingPercent <= 0) return 'EXHAUSTED';
  if (remainingPercent > thresholds.healthy) return 'HEALTHY';
  if (remainingPercent >= thresholds.moderate) return 'MODERATE';
  if (remainingPercent >= thresholds.low) return 'LOW';
  return 'CRITICAL';
}

export function windowFromRemaining(remainingPercent, resetsAtSec, now) {
  const remaining = clamp(remainingPercent, 0, 100);
  const hasReset = typeof resetsAtSec === 'number';
  return {
    remainingPercent: remaining,
    usedPercent: 100 - remaining,
    resetsAt: hasReset ? new Date(resetsAtSec * 1000).toISOString() : null,
    resetInSeconds: hasReset ? Math.max(0, resetsAtSec - Math.floor(now.getTime() / 1000)) : null,
  };
}

export function windowFromUsed(usedPercent, resetsAtSec, now) {
  return windowFromRemaining(100 - usedPercent, resetsAtSec, now);
}

export function freshnessFor({ source, retrievedAt, now, ttl }) {
  if (source === 'none' || !retrievedAt) return 'UNKNOWN';
  if (source === 'manual') return 'STALE';
  const age = (now.getTime() - new Date(retrievedAt).getTime()) / 1000;
  return age <= ttl ? 'LIVE' : 'STALE';
}

function emptyWindows() {
  return { short: 'UNKNOWN', daily: 'UNKNOWN', weekly: 'UNKNOWN' };
}

function windowLevel(name, w, estimatedMinutes, thresholds) {
  let rank = LEVELS.indexOf(levelFor(w.remainingPercent, thresholds));
  if (rank === 0) return rank;
  if (w.resetInSeconds !== null) {
    if (estimatedMinutes > 0 && w.resetInSeconds < estimatedMinutes * 60) rank = Math.min(4, rank + 1);
    if (name === 'weekly' && rank < 4 && w.resetInSeconds > WEEKLY_FAR_SECONDS) rank = Math.max(1, rank - 1);
  }
  return rank;
}

export function buildQuota({ provider, source, retrievedAt, windows, config, now, estimatedMinutes = 0 }) {
  const full = { ...emptyWindows(), ...windows };
  const known = WINDOW_NAMES.filter((n) => typeof full[n] === 'object' && full[n] !== null);
  const ttl = config.quotaTtlSeconds ?? 600;
  const base = {
    provider,
    available: known.length > 0,
    source,
    retrievedAt: retrievedAt ? iso(retrievedAt) : null,
    freshness: freshnessFor({ source, retrievedAt, now, ttl }),
    windows: full,
  };
  if (!known.length) return { ...base, health: 'UNKNOWN' };

  const exhausted = known.some((n) => full[n].remainingPercent <= 0);
  if (exhausted) return { ...base, health: 'EXHAUSTED' };

  const weekly = full.weekly;
  const reserve = config.reserves?.[provider] ?? 0;
  if (typeof weekly === 'object' && weekly.remainingPercent < reserve) return { ...base, health: 'PROTECTED' };

  const worst = Math.min(...known.map((n) => windowLevel(n, full[n], estimatedMinutes, config.thresholds)));
  return { ...base, health: LEVELS[worst] };
}

export function unknownQuota(provider) {
  return {
    provider,
    available: false,
    source: 'none',
    retrievedAt: null,
    freshness: 'UNKNOWN',
    health: 'UNKNOWN',
    windows: emptyWindows(),
  };
}

export function unavailableQuota(provider, source, now, reason) {
  return {
    provider,
    available: false,
    source,
    retrievedAt: iso(now),
    freshness: 'UNAVAILABLE',
    health: 'UNKNOWN',
    windows: emptyWindows(),
    reason,
  };
}

export function manualQuota({ provider, daily, weekly, now, config }) {
  const windows = {};
  if (typeof daily === 'number') windows.daily = windowFromRemaining(daily, null, now);
  if (typeof weekly === 'number') windows.weekly = windowFromRemaining(weekly, null, now);
  return buildQuota({ provider, source: 'manual', retrievedAt: now, windows, config, now });
}

export function reactiveExhausted(provider, now) {
  return {
    provider,
    available: true,
    source: 'reactive',
    retrievedAt: iso(now),
    freshness: 'LIVE',
    health: 'EXHAUSTED',
    windows: emptyWindows(),
  };
}

export function cacheGet(cache, provider, now, ttlSeconds) {
  const entry = cache?.[provider];
  if (!entry?.retrievedAt) return null;
  const age = (now.getTime() - new Date(entry.retrievedAt).getTime()) / 1000;
  return age <= ttlSeconds ? entry : null;
}
