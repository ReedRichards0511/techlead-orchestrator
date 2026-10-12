import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAllQuotas, setManual, markExhausted, formatDashboard, formatDuration } from '../lib/quota/index.mjs';
import { windowFromUsed, buildQuota, unknownQuota } from '../lib/quota/normalize.mjs';

const cfg = {
  thresholds: { healthy: 50, moderate: 25, low: 10 },
  reserves: { claude: 35, codex: 20, devin: 0, antigravity: 10 },
  quotaTtlSeconds: 600,
};
const now = new Date('2026-10-12T12:00:00Z');
const inSec = (s) => Math.floor(now.getTime() / 1000) + s;

function codexQuota(usedShort = 29, usedWeekly = 57) {
  return buildQuota({
    provider: 'codex', source: 'official', retrievedAt: now, now, config: cfg,
    windows: { short: windowFromUsed(usedShort, inSec(7920), now), weekly: windowFromUsed(usedWeekly, inSec(2 * 86400), now) },
  });
}

function deps(over = {}) {
  const calls = { codex: 0, claude: 0 };
  return {
    calls,
    deps: {
      fetchCodex: async () => {
        calls.codex++;
        return codexQuota();
      },
      readClaude: () => {
        calls.claude++;
        return unknownQuota('claude');
      },
      fetchDevin: null,
      ...over,
    },
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'orch-qs-'));

test('getAllQuotas fetches every provider and writes quota-cache.json', async () => {
  const dir = tmp();
  const d = deps();
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps });
  assert.deepEqual(Object.keys(all).sort(), ['antigravity', 'claude', 'codex', 'devin']);
  assert.equal(all.codex.windows.short.remainingPercent, 71);
  assert.equal(all.antigravity.health, 'UNKNOWN');
  assert.ok(existsSync(join(dir, 'quota-cache.json')));
});

test('a fresh cache avoids refetching; refresh forces it', async () => {
  const dir = tmp();
  const d = deps();
  await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps });
  await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 60000), deps: d.deps });
  assert.equal(d.calls.codex, 1);
  await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 60000), deps: d.deps, refresh: true });
  assert.equal(d.calls.codex, 2);
});

test('a stale cache is refetched', async () => {
  const dir = tmp();
  const d = deps();
  await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps });
  await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 15 * 60000), deps: d.deps });
  assert.equal(d.calls.codex, 2);
});

test('a failing fetch is reported as UNAVAILABLE without throwing', async () => {
  const dir = tmp();
  const d = deps({ fetchCodex: async () => { throw new Error('boom'); } });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps });
  assert.equal(all.codex.freshness, 'UNAVAILABLE');
  assert.equal(all.codex.health, 'UNKNOWN');
});

test('manual devin quota persists and is not overwritten by a refresh without an unofficial source', async () => {
  const dir = tmp();
  const d = deps();
  setManual({ stateDir: dir, provider: 'devin', daily: 80, weekly: 60, now, config: cfg });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps, refresh: true });
  assert.equal(all.devin.source, 'manual');
  assert.equal(all.devin.windows.weekly.remainingPercent, 60);
});

test('a live unofficial devin reading wins over a manual one', async () => {
  const dir = tmp();
  setManual({ stateDir: dir, provider: 'devin', daily: 10, weekly: 10, now, config: cfg });
  const live = buildQuota({
    provider: 'devin', source: 'unofficial', retrievedAt: now, now, config: cfg,
    windows: { daily: windowFromUsed(3, inSec(40000), now), weekly: windowFromUsed(9, inSec(6 * 86400), now) },
  });
  const d = deps({ fetchDevin: async () => live });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps, refresh: true });
  assert.equal(all.devin.source, 'unofficial');
  assert.equal(all.devin.windows.daily.remainingPercent, 97);
});

test('markExhausted records a reactive EXHAUSTED state that survives refresh', async () => {
  const dir = tmp();
  const d = deps();
  markExhausted({ stateDir: dir, provider: 'codex', now });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 60000), deps: d.deps });
  assert.equal(all.codex.health, 'EXHAUSTED');
  assert.equal(all.codex.source, 'reactive');
});

test('a live reading does not clear a reactive exhaustion before it expires, even on a forced refresh', async () => {
  const dir = tmp();
  const d = deps();
  markExhausted({ stateDir: dir, provider: 'codex', now });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 60000), deps: d.deps, refresh: true });
  assert.equal(all.codex.source, 'reactive');
  assert.equal(all.codex.health, 'EXHAUSTED');
  const later = await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 3700000), deps: d.deps, refresh: true });
  assert.equal(later.codex.source, 'official');
  assert.notEqual(later.codex.health, 'EXHAUSTED');
});

test('the cache file never contains account identifiers', async () => {
  const dir = tmp();
  await getAllQuotas({ stateDir: dir, config: cfg, now, deps: deps().deps });
  const text = readFileSync(join(dir, 'quota-cache.json'), 'utf8');
  assert.equal(/@|accountId|api[_-]?key|token/i.test(text), false);
});

test('formatDuration is compact', () => {
  assert.equal(formatDuration(7920), '2h12m');
  assert.equal(formatDuration(3 * 86400 + 5000), '3d');
  assert.equal(formatDuration(2700), '45m');
  assert.equal(formatDuration(null), '-');
});

test('formatDashboard renders the plan layout without secrets', async () => {
  const dir = tmp();
  const claude = buildQuota({
    provider: 'claude', source: 'statusline', retrievedAt: now, now, config: cfg,
    windows: { short: windowFromUsed(29, inSec(7920), now), weekly: windowFromUsed(57, inSec(3 * 86400 - 60), now) },
  });
  const d = deps({ readClaude: () => claude });
  const all = await getAllQuotas({ stateDir: dir, config: cfg, now, deps: d.deps });
  const text = formatDashboard(all, cfg);
  assert.match(text, /CLAUDE\s+source: statusline\s+freshness: LIVE/);
  assert.match(text, /5h\s+71% remaining\s+reset 2h12m\s+HEALTHY/);
  assert.match(text, /weekly\s+43% remaining\s+reset 2d\s+MODERATE \(reserve 35%\)/);
  assert.match(text, /ANTIGRAVITY[\s\S]*UNKNOWN \(reactive only\)/);
  assert.equal(text.includes('@'), false);
});

test('a reactive exhaustion with no live source expires after an hour', async () => {
  const dir = tmp();
  const d = deps();
  markExhausted({ stateDir: dir, provider: 'antigravity', now });
  const soon = await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 30 * 60000), deps: d.deps });
  assert.equal(soon.antigravity.health, 'EXHAUSTED');
  const later = await getAllQuotas({ stateDir: dir, config: cfg, now: new Date(now.getTime() + 61 * 60000), deps: d.deps });
  assert.equal(later.antigravity.health, 'UNKNOWN');
});
