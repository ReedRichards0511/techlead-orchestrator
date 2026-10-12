import { runDoctor } from '../doctor.mjs';
import { capture } from '../proc.mjs';
import { loadConfig, readJson } from '../config.mjs';
import { join } from 'node:path';

export function formatDoctor(d) {
  const lines = [];
  lines.push(`OS        ${d.os.platform} ${d.os.release} ${d.os.arch}`);
  lines.push(`Node      ${d.node}    Git ${d.git ?? 'missing'}    Session ${d.session.kind}`);
  lines.push('');
  lines.push('CLI       version     auth        path');
  for (const [name, c] of Object.entries(d.clis)) {
    lines.push(`${name.padEnd(9)} ${(c.version ?? '-').padEnd(11)} ${c.auth.padEnd(11)} ${c.path ?? 'NOT FOUND'}`);
  }
  lines.push('');
  lines.push(`Catalog   ${d.catalog.present ? `${d.catalog.models} models, ${d.catalog.ageDays}d old` : 'missing (run: models refresh)'}`);
  lines.push('Quota     ' + Object.entries(d.quota).map(([k, v]) => `${k}: ${v}`).join(' | '));
  if (d.warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of d.warnings) lines.push(`  - ${w}`);
  }
  lines.push('', 'Pending checks:');
  for (const p of d.pending) lines.push(`  ${p.id} [${p.status}] ${p.title}`);
  lines.push('', d.ok ? 'RESULT: OK' : 'RESULT: NOT READY');
  return lines.join('\n');
}

export async function main(args, ctx) {
  const config = loadConfig({ stateDir: ctx.stateDir });
  const catalog = readJson(join(ctx.stateDir, 'catalog.json'), null);
  const d = await runDoctor({
    run: (exe, a) => capture(exe, a, { timeoutMs: 30000 }),
    env: process.env,
    catalog,
    overrides: config.platformOverrides?.paths ?? {},
  });
  console.log(args.includes('--json') ? JSON.stringify(d, null, 2) : formatDoctor(d));
  return d.ok ? 0 : 1;
}
