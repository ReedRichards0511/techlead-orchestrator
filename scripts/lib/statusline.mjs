const WINDOWS = ['five_hour', 'seven_day'];

function validWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const { used_percentage: used, resets_at: resets } = w;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return null;
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  return { used_percentage: used, resets_at: resets };
}

export function extractUsage(input) {
  const limits = input?.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const out = {};
  for (const name of WINDOWS) {
    const w = validWindow(limits[name]);
    if (w) out[name] = w;
  }
  return Object.keys(out).length ? out : null;
}

export function renderLine(usage) {
  if (!usage) return '';
  const labels = { five_hour: '5h', seven_day: '7d' };
  return WINDOWS.filter((n) => usage[n])
    .map((n) => `${labels[n]} ${Math.round(100 - usage[n].used_percentage)}%`)
    .join(' · ');
}
