import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  windowFromUsed,
  windowFromRemaining,
  levelFor,
  buildQuota,
  unknownQuota,
  manualQuota,
  reactiveExhausted,
  freshnessFor,
  cacheGet,
} from '../lib/quota/normalize.mjs';

const thresholds = { healthy: 50, moderate: 25, low: 10 };
const reserves = { claude: 35, codex: 20, devin: 0, antigravity: 10 };
const now = new Date('2026-10-12T12:00:00Z');
const cfg = { thresholds, reserves, quotaTtlSeconds: 600 };
const inSec = (s) => Math.floor(now.getTime() / 1000) + s;

test('absent or non-numeric percentages stay UNKNOWN instead of becoming available quota', () => {
  for (const value of [null, undefined, NaN, Infinity, '0']) {
    assert.equal(windowFromUsed(value, null, now), 'UNKNOWN');
    assert.equal(windowFromRemaining(value, null, now), 'UNKNOWN');
    const q = buildQuota({ provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg, windows: { short: { remainingPercent: value } } });
    assert.equal(q.health, 'UNKNOWN');
    assert.equal(q.available, false);
  }
});

test('levelFor follows the plan thresholds', () => {
  assert.equal(levelFor(100, thresholds), 'HEALTHY');
  assert.equal(levelFor(51, thresholds), 'HEALTHY');
  assert.equal(levelFor(50, thresholds), 'MODERATE');
  assert.equal(levelFor(25, thresholds), 'MODERATE');
  assert.equal(levelFor(24.9, thresholds), 'LOW');
  assert.equal(levelFor(10, thresholds), 'LOW');
  assert.equal(levelFor(9.9, thresholds), 'CRITICAL');
  assert.equal(levelFor(0, thresholds), 'EXHAUSTED');
});

test('windowFromUsed derives remaining, ISO reset and seconds to reset', () => {
  const w = windowFromUsed(29, inSec(7920), now);
  assert.equal(w.usedPercent, 29);
  assert.equal(w.remainingPercent, 71);
  assert.equal(w.resetInSeconds, 7920);
  assert.equal(w.resetsAt, new Date(inSec(7920) * 1000).toISOString());
});

test('windowFromRemaining without reset leaves reset fields null', () => {
  const w = windowFromRemaining(80, null, now);
  assert.equal(w.remainingPercent, 80);
  assert.equal(w.resetInSeconds, null);
});

test('provider health is the worst window', () => {
  const q = buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg,
    windows: { short: windowFromUsed(10, inSec(3600), now), weekly: windowFromUsed(80, inSec(86400), now) },
  });
  assert.equal(q.health, 'LOW');
});

test('weekly window resetting in more than 3 days drops one level', () => {
  const q = buildQuota({
    provider: 'devin', source: 'unofficial', retrievedAt: now, now, config: cfg,
    windows: { weekly: windowFromUsed(60, inSec(4 * 86400), now) },
  });
  assert.equal(q.health, 'LOW');
});

test('a reset that arrives before the task ends raises one level', () => {
  const q = buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg, estimatedMinutes: 30,
    windows: { short: windowFromUsed(92, inSec(600), now) },
  });
  assert.equal(q.health, 'LOW');
});

test('below the weekly reserve the provider is PROTECTED', () => {
  const codex = buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg,
    windows: { short: windowFromUsed(10, inSec(3600), now), weekly: windowFromUsed(85, inSec(86400), now) },
  });
  assert.equal(codex.health, 'PROTECTED');
  const claude = buildQuota({
    provider: 'claude', source: 'statusline', retrievedAt: now, now, config: cfg,
    windows: { weekly: windowFromUsed(70, inSec(86400), now) },
  });
  assert.equal(claude.health, 'PROTECTED');
});

test('a zero reserve never protects', () => {
  const q = buildQuota({
    provider: 'devin', source: 'unofficial', retrievedAt: now, now, config: cfg,
    windows: { weekly: windowFromUsed(95, inSec(86400), now) },
  });
  assert.equal(q.health, 'CRITICAL');
});

test('EXHAUSTED wins over PROTECTED', () => {
  const q = buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg,
    windows: { weekly: windowFromUsed(100, inSec(86400), now) },
  });
  assert.equal(q.health, 'EXHAUSTED');
});

test('unknown windows are never counted as 100%', () => {
  const q = buildQuota({
    provider: 'devin', source: 'unofficial', retrievedAt: now, now, config: cfg,
    windows: { short: 'UNKNOWN', weekly: windowFromUsed(95, inSec(86400), now) },
  });
  assert.equal(q.health, 'CRITICAL');
  assert.equal(q.windows.short, 'UNKNOWN');
  assert.equal(q.windows.daily, 'UNKNOWN');
});

test('unknownQuota has no numbers at all', () => {
  const q = unknownQuota('antigravity');
  assert.equal(q.health, 'UNKNOWN');
  assert.equal(q.freshness, 'UNKNOWN');
  assert.equal(q.available, false);
  assert.equal(q.source, 'none');
  assert.equal(/\d/.test(JSON.stringify(q.windows)), false);
});

test('freshness depends on source and age', () => {
  assert.equal(freshnessFor({ source: 'official', retrievedAt: new Date(now - 5 * 60000), now, ttl: 600 }), 'LIVE');
  assert.equal(freshnessFor({ source: 'official', retrievedAt: new Date(now - 15 * 60000), now, ttl: 600 }), 'STALE');
  assert.equal(freshnessFor({ source: 'none', retrievedAt: null, now, ttl: 600 }), 'UNKNOWN');
  assert.equal(freshnessFor({ source: 'manual', retrievedAt: now, now, ttl: 600 }), 'STALE');
});

test('manual quota is STALE, timestamped and uses remaining percentages', () => {
  const q = manualQuota({ provider: 'devin', daily: 80, weekly: 60, now, config: cfg });
  assert.equal(q.source, 'manual');
  assert.equal(q.freshness, 'STALE');
  assert.equal(q.retrievedAt, now.toISOString());
  assert.equal(q.windows.daily.remainingPercent, 80);
  assert.equal(q.windows.weekly.remainingPercent, 60);
  assert.equal(q.health, 'HEALTHY');
});

test('reactive exhaustion marks the provider EXHAUSTED', () => {
  const q = reactiveExhausted('codex', now);
  assert.equal(q.health, 'EXHAUSTED');
  assert.equal(q.source, 'reactive');
});

test('cacheGet honors the TTL', () => {
  const cache = { codex: { retrievedAt: new Date(now - 5 * 60000).toISOString(), health: 'HEALTHY' } };
  assert.ok(cacheGet(cache, 'codex', now, 600));
  assert.equal(cacheGet(cache, 'codex', new Date(now.getTime() + 10 * 60000), 600), null);
  assert.equal(cacheGet(cache, 'devin', now, 600), null);
});

test('a far weekly reset does not penalize a window that is still HEALTHY', () => {
  const q = buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg,
    windows: { short: windowFromUsed(0, inSec(3600), now), weekly: windowFromUsed(0, inSec(6 * 86400), now) },
  });
  assert.equal(q.health, 'HEALTHY');
});
