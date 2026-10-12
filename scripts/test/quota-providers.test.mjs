import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRateLimits, fetchCodexQuota } from '../lib/quota/codex.mjs';
import { readClaudeUsage } from '../lib/quota/claude.mjs';
import { agyQuota } from '../lib/quota/agy.mjs';

const now = new Date('2026-10-12T12:00:00Z');
const cfg = {
  thresholds: { healthy: 50, moderate: 25, low: 10 },
  reserves: { claude: 35, codex: 20, devin: 0, antigravity: 10 },
  quotaTtlSeconds: 600,
};
const inSec = (s) => Math.floor(now.getTime() / 1000) + s;

const sample = (over = {}) => ({
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: inSec(7920) },
    secondary: { usedPercent: 57, windowDurationMins: 10080, resetsAt: inSec(3 * 86400) },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    planType: 'plus',
  },
  rateLimitResetCredits: { availableCount: 3, credits: [{ id: 'secret-credit-id', title: 'Full reset' }] },
  accountId: 'acct-secret',
  ...over,
});

test('parseRateLimits maps primary to short and secondary to weekly', () => {
  const q = parseRateLimits(sample(), { now, config: cfg });
  assert.equal(q.provider, 'codex');
  assert.equal(q.source, 'official');
  assert.equal(q.windows.short.remainingPercent, 71);
  assert.equal(q.windows.weekly.remainingPercent, 43);
  assert.equal(q.windows.daily, 'UNKNOWN');
  assert.equal(q.freshness, 'LIVE');
});

test('parseRateLimits never exposes reset credits or account ids', () => {
  const text = JSON.stringify(parseRateLimits(sample(), { now, config: cfg }));
  for (const banned of ['secret-credit-id', 'acct-secret', 'rateLimitResetCredits', 'availableCount', 'accountId']) {
    assert.equal(text.includes(banned), false, banned);
  }
});

test('ordinaryUsageAllowed=false forces EXHAUSTED', () => {
  const q = parseRateLimits(sample({ ordinaryUsageAllowed: false }), { now, config: cfg });
  assert.equal(q.health, 'EXHAUSTED');
});

test('windows are classified by duration, not by position', () => {
  const swapped = sample();
  const { primary, secondary } = swapped.rateLimits;
  swapped.rateLimits.primary = secondary;
  swapped.rateLimits.secondary = primary;
  const q = parseRateLimits(swapped, { now, config: cfg });
  assert.equal(q.windows.short.remainingPercent, 71);
  assert.equal(q.windows.weekly.remainingPercent, 43);
});

const fakeServer = (body) => `
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
  rl.on('line', (line) => {
    const msg = JSON.parse(line);
    ${body}
  });
`;

test('fetchCodexQuota speaks initialize -> initialized -> account/rateLimits/read', async () => {
  const seen = [];
  const dir = mkdtempSync(join(tmpdir(), 'orch-codex-'));
  const script = join(dir, 'server.js');
  const result = JSON.stringify(sample());
  writeFileSync(
    script,
    fakeServer(`
      require('node:fs').appendFileSync(${JSON.stringify(join(dir, 'seen.log'))}, (msg.method || 'response') + '\\n');
      if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'x' } });
      if (msg.method === 'account/rateLimits/read') send({ id: msg.id, result: ${result} });
    `),
  );
  const q = await fetchCodexQuota({ exe: process.execPath, args: [script], now, config: cfg, timeoutMs: 5000 });
  assert.equal(q.windows.weekly.remainingPercent, 43);
  const log = (await import('node:fs')).readFileSync(join(dir, 'seen.log'), 'utf8').trim().split('\n');
  assert.deepEqual(log, ['initialize', 'initialized', 'account/rateLimits/read']);
  void seen;
});

test('fetchCodexQuota reports UNAVAILABLE when the server never answers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-codex-'));
  const script = join(dir, 'silent.js');
  writeFileSync(script, 'setInterval(()=>{},1000)');
  const q = await fetchCodexQuota({ exe: process.execPath, args: [script], now, config: cfg, timeoutMs: 800 });
  assert.equal(q.freshness, 'UNAVAILABLE');
  assert.equal(q.health, 'UNKNOWN');
});

test('fetchCodexQuota reports UNAVAILABLE for a JSON-RPC error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-codex-'));
  const script = join(dir, 'err.js');
  writeFileSync(
    script,
    fakeServer(`
      if (msg.method === 'initialize') send({ id: msg.id, result: {} });
      if (msg.method === 'account/rateLimits/read') send({ id: msg.id, error: { code: -1, message: 'nope' } });
    `),
  );
  const q = await fetchCodexQuota({ exe: process.execPath, args: [script], now, config: cfg, timeoutMs: 3000 });
  assert.equal(q.freshness, 'UNAVAILABLE');
});

test('readClaudeUsage reads the statusline snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  const file = join(dir, 'claude-usage.json');
  writeFileSync(
    file,
    JSON.stringify({
      writtenAt: new Date(now - 60000).toISOString(),
      rate_limits: {
        five_hour: { used_percentage: 29, resets_at: inSec(7920) },
        seven_day: { used_percentage: 57, resets_at: inSec(3 * 86400) },
      },
    }),
  );
  const q = readClaudeUsage({ file, now, config: cfg });
  assert.equal(q.source, 'statusline');
  assert.equal(q.windows.short.remainingPercent, 71);
  assert.equal(q.windows.weekly.remainingPercent, 43);
  assert.equal(q.freshness, 'LIVE');
});

test('readClaudeUsage marks an old snapshot STALE', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-claude-'));
  const file = join(dir, 'claude-usage.json');
  writeFileSync(
    file,
    JSON.stringify({
      writtenAt: new Date(now - 3 * 3600 * 1000).toISOString(),
      rate_limits: { five_hour: { used_percentage: 10, resets_at: inSec(100) }, seven_day: { used_percentage: 10, resets_at: inSec(86400) } },
    }),
  );
  assert.equal(readClaudeUsage({ file, now, config: cfg }).freshness, 'STALE');
});

test('readClaudeUsage without a snapshot is UNKNOWN', () => {
  const q = readClaudeUsage({ file: join(tmpdir(), 'no-such-usage.json'), now, config: cfg });
  assert.equal(q.health, 'UNKNOWN');
  assert.equal(q.source, 'none');
});

test('agyQuota is always UNKNOWN and never spends a turn', () => {
  const q = agyQuota();
  assert.equal(q.provider, 'antigravity');
  assert.equal(q.health, 'UNKNOWN');
  assert.equal(q.source, 'none');
});
