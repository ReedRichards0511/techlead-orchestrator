import { existsSync, readFileSync } from 'node:fs';
import { buildQuota, unknownQuota, windowFromUsed } from './normalize.mjs';

export function readClaudeUsage({ file, now, config, estimatedMinutes = 0 }) {
  if (!existsSync(file)) return unknownQuota('claude');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return unknownQuota('claude');
  }
  const limits = data.rate_limits ?? {};
  const windows = {};
  if (limits.five_hour) windows.short = windowFromUsed(limits.five_hour.used_percentage, limits.five_hour.resets_at, now);
  if (limits.seven_day) windows.weekly = windowFromUsed(limits.seven_day.used_percentage, limits.seven_day.resets_at, now);
  if (!Object.keys(windows).length || !data.writtenAt) return unknownQuota('claude');
  return buildQuota({
    provider: 'claude',
    source: 'statusline',
    retrievedAt: data.writtenAt,
    windows,
    config,
    now,
    estimatedMinutes,
  });
}
